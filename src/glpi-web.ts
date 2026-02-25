import fs from "fs";
import path from "path";
import puppeteer, { Browser, Page } from "puppeteer";

// Ignorar errores de certificado SSL para GLPI
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

export type GlpiCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  url?: string;
  session?: boolean;
};

export type GlpiSessionData = {
  cookies: GlpiCookie[];
  createdAt: number;
  expiresAt?: number;
  userId?: string;
};

export type MfaState = {
  isWaiting: boolean;
  page: Page | null;
  resolve: (success: boolean) => void;
  reject: (error: Error) => void;
};

export type GlpiLoginState = {
  step: 'initial' | 'awaiting-mfa' | 'completed' | 'error';
  csrfToken?: string;
  sessionCookie?: string;
  error?: string;
};

export class GlpiWebClient {
  private baseUrl: string;
  private loginUrl: string;
  private cookieFile: string;
  private sessionData: GlpiSessionData | null = null;
  private mfaState: MfaState | null = null;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private username: string;
  private password: string;
  private loginState: GlpiLoginState = { step: 'initial' };

  constructor(baseUrl: string, loginUrl: string, cookieFile: string, username: string = '', password: string = '') {
    this.baseUrl = baseUrl.replace('/apirest.php', '');
    this.loginUrl = loginUrl;
    this.cookieFile = cookieFile;
    this.username = username;
    this.password = password;
  }

  /**
   * Inicia el login con usuario/password y devuelve el estado para MFA
   */
  async startLoginWithMfa(): Promise<GlpiLoginState> {
    try {
      console.log('🔐 Iniciando login GLPI con credenciales...');
      
      // Esperar un poco para evitar rate limiting (429)
      await this.sleep(2000);
      
      // Paso 1: Obtener index.php para obtener cookie y CSRF
      console.log('   Obteniendo index.php...');
      const indexResponse = await fetch(`${this.baseUrl}/index.php`, {
        method: 'GET',
        redirect: 'follow',
      });
      
      const indexHtml = await indexResponse.text();
      
      // Extraer CSRF token del meta tag
      let csrfToken = '';
      const metaCsrfMatch = indexHtml.match(/<meta[^>]+property="glpi:csrf_token"[^>]+content="([^"]+)"/);
      if (metaCsrfMatch && metaCsrfMatch[1]) {
        csrfToken = metaCsrfMatch[1];
        console.log('   CSRF token (meta):', csrfToken.substring(0, 20) + '...');
      } else {
        // Buscar en formulario
        const formCsrfMatch = indexHtml.match(/name="_glpi_csrf_token"[^>]+value="([^"]+)"/);
        if (formCsrfMatch && formCsrfMatch[1]) {
          csrfToken = formCsrfMatch[1];
          console.log('   CSRF token (form):', csrfToken.substring(0, 20) + '...');
        } else {
          // Guardar HTML para debug
          fs.writeFileSync('/tmp/glpi-index.html', indexHtml);
          throw new Error('No se encontró CSRF token. Ver /tmp/glpi-index.html');
        }
      }
      
      // Extraer cookie de sesión
      let sessionCookie = '';
      const setCookie = indexResponse.headers.get('set-cookie');
      if (setCookie) {
        const cookieMatch = setCookie.match(/glpi_cc188a941720df9f577e8405f6df8e6e=([^;]+)/);
        if (cookieMatch) {
          sessionCookie = cookieMatch[1];
          console.log('   Cookie:', sessionCookie.substring(0, 10) + '...');
        }
      }
      
      // Extraer campos dinámicos del HTML (ej: fielda699f3624229cc)
      // El regex busca name="fieldX..." donde el valor contiene fielda/fieldb/fieldc seguido de hex
      const userFieldMatch = indexHtml.match(/name="(fielda[0-9a-f]+)"/);
      const passFieldMatch = indexHtml.match(/name="(fieldb[0-9a-f]+)"/);
      const rememberFieldMatch = indexHtml.match(/name="(fieldc[0-9a-f]+)"/);
      
      if (!userFieldMatch || !passFieldMatch || !userFieldMatch[1] || !passFieldMatch[1]) {
        fs.writeFileSync('/tmp/glpi-index.html', indexHtml);
        console.log('   userFieldMatch:', userFieldMatch ? userFieldMatch[1] : 'null');
        console.log('   passFieldMatch:', passFieldMatch ? passFieldMatch[1] : 'null');
        console.log('   rememberFieldMatch:', rememberFieldMatch ? rememberFieldMatch[1] : 'null');
        throw new Error('No se encontraron campos de login. Ver /tmp/glpi-index.html');
      }
      
      const userFieldName = userFieldMatch[1];
      const passFieldName = passFieldMatch[1];
      const rememberFieldName = rememberFieldMatch ? rememberFieldMatch[1] : null;
      
      console.log('   Campos:', userFieldName, passFieldName, rememberFieldName || '(sin remember)');
      
      // Paso 2: Enviar login al endpoint MFA
      console.log('   Enviando credenciales...');
      
      const loginPayload = new URLSearchParams({
        noAUTO: '0',
        redirect: '',
        _glpi_csrf_token: csrfToken,
        [userFieldName]: this.username,
        [passFieldName]: this.password,
        auth: 'local',
        ...(rememberFieldName && { [rememberFieldName]: 'on' }),
        submit: '',
      });
      
      const mfaResponse = await fetch(`${this.baseUrl}/plugins/mfa/front/mfa.form.php`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': `glpi_cc188a941720df9f577e8405f6df8e6e=${sessionCookie}`,
          'Origin': this.baseUrl,
          'Referer': `${this.baseUrl}/index.php`,
        },
        body: loginPayload,
        redirect: 'manual',
      });
      
      console.log('   Respuesta MFA:', mfaResponse.status);
      
      // Manejar error 429 (Too Many Requests)
      if (mfaResponse.status === 429) {
        throw new Error('Demasiados intentos de login. Espera unos minutos e intenta nuevamente.');
      }
      
      // Verificar redirect a central.php
      const location = mfaResponse.headers.get('location');
      if (location && location.includes('central.php')) {
        console.log('✅ Login completado directamente');
        const newSetCookie = mfaResponse.headers.get('set-cookie');
        if (newSetCookie) {
          const cookieMatch = newSetCookie.match(/glpi_cc188a941720df9f577e8405f6df8e6e=([^;]+)/);
          if (cookieMatch) {
            this.sessionData = {
              cookies: [{
                name: 'glpi_cc188a941720df9f577e8405f6df8e6e',
                value: cookieMatch[1],
                domain: new URL(this.baseUrl).hostname,
                path: '/',
                httpOnly: true,
                secure: true,
                sameSite: 'Lax',
              }],
              createdAt: Date.now(),
              expiresAt: Date.now() + (24 * 60 * 60 * 1000),
            };
            await this.saveCookies();
          }
        }
        this.loginState = { step: 'completed' };
        return this.loginState;
      }
      
      // Paso 3: Verificar formulario MFA
      const mfaHtml = await mfaResponse.text();
      
      // Buscar formulario MFA de varias formas
      const hasMfaInput = mfaHtml.includes('name="code"') || 
                         mfaHtml.includes("name='code'") ||
                         mfaHtml.includes('MFA') ||
                         mfaHtml.includes('código de verificación') ||
                         mfaHtml.includes('verification code');
      
      if (hasMfaInput) {
        console.log('✅ Esperando código MFA');
        
        // Extraer CSRF del formulario MFA
        const mfaCsrfMatch = mfaHtml.match(/name="_glpi_csrf_token"[^>]+value="([^"]+)"/);
        
        this.loginState = {
          step: 'awaiting-mfa',
          csrfToken: mfaCsrfMatch ? mfaCsrfMatch[1] : csrfToken,
          sessionCookie: sessionCookie,
        };
        
        return this.loginState;
      } else {
        fs.writeFileSync('/tmp/glpi-login-response.html', mfaHtml);
        console.log('   HTML guardado en /tmp/glpi-login-response.html');
        
        // Buscar mensaje de error en el HTML
        const errorMatch = mfaHtml.match(/class="center b">([^<]+)<br>/);
        if (errorMatch) {
          throw new Error(`Login fallido: ${errorMatch[1]}`);
        }
        
        throw new Error('Respuesta inesperada');
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error('❌ Error en startLoginWithMfa:', error);
      this.loginState = { step: 'error', error };
      return this.loginState;
    }
  }

  /**
   * Envía el código MFA y guarda la sesión
   */
  async submitMfaCodeHttp(code: string): Promise<{ success: boolean; error?: string }> {
    try {
      console.log('🔢 Enviando código MFA:', code);
      
      if (this.loginState.step !== 'awaiting-mfa') {
        return { success: false, error: 'No hay un login pendiente. Inicia el login primero.' };
      }
      
      const mfaPayload = new URLSearchParams({
        _glpi_csrf_token: this.loginState.csrfToken || '',
        code: code,
        submit: '',
      });
      
      const cookieHeader = `glpi_cc188a941720df9f577e8405f6df8e6e=${this.loginState.sessionCookie || ''}`;
      
      const mfaResponse = await fetch(`${this.baseUrl}/plugins/mfa/front/mfa.form.php`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': cookieHeader,
          'Origin': this.baseUrl,
          'Referer': `${this.baseUrl}/plugins/mfa/front/mfa.form.php`,
        },
        body: mfaPayload,
        redirect: 'manual',
      });
      
      // Verificar redirect a central.php (login exitoso)
      const location = mfaResponse.headers.get('location');
      if (location && location.includes('central.php')) {
        console.log('✅ Código MFA aceptado, login completado');
        
        // Extraer cookie de sesión final
        const newSetCookie = mfaResponse.headers.get('set-cookie');
        if (newSetCookie) {
          const cookieMatch = newSetCookie.match(/glpi_cc188a941720df9f577e8405f6df8e6e=([^;]+)/);
          if (cookieMatch) {
            // Guardar sesión con la nueva cookie
            this.sessionData = {
              cookies: [{
                name: 'glpi_cc188a941720df9f577e8405f6df8e6e',
                value: cookieMatch[1],
                domain: new URL(this.baseUrl).hostname,
                path: '/',
                httpOnly: true,
                secure: true,
                sameSite: 'Lax',
              }],
              createdAt: Date.now(),
              expiresAt: Date.now() + (24 * 60 * 60 * 1000),
            };
            await this.saveCookies();
            console.log('🍪 Cookies guardadas');
          }
        }
        
        this.loginState = { step: 'completed' };
        return { success: true };
      } else {
        return { success: false, error: 'Código MFA incorrecto o expirado' };
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error('❌ Error en submitMfaCodeHttp:', error);
      return { success: false, error };
    }
  }

  async loadCookies(): Promise<boolean> {
    try {
      if (!fs.existsSync(this.cookieFile)) {
        console.log('🍪 No existe archivo de cookies de GLPI');
        return false;
      }
      const raw = fs.readFileSync(this.cookieFile, 'utf-8');
      this.sessionData = JSON.parse(raw) as GlpiSessionData;
      
      // Verificar si las cookies expiraron
      if (this.sessionData.expiresAt && Date.now() > this.sessionData.expiresAt) {
        console.log('🍪 Cookies de GLPI expiradas');
        this.sessionData = null;
        return false;
      }
      
      console.log('🍪 Cookies de GLPI cargadas correctamente');
      return true;
    } catch (err) {
      console.error('Error al cargar cookies:', err);
      this.sessionData = null;
      return false;
    }
  }

  async saveCookies(): Promise<void> {
    if (!this.sessionData) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(this.cookieFile), { recursive: true });
      fs.writeFileSync(this.cookieFile, JSON.stringify(this.sessionData, null, 2));
      console.log('🍪 Cookies de GLPI guardadas en', this.cookieFile);
    } catch (err) {
      console.error('Error al guardar cookies:', err);
    }
  }

  async isSessionValid(): Promise<boolean> {
    if (!this.sessionData || this.sessionData.cookies.length === 0) {
      return false;
    }

    // Verificar expiración
    if (this.sessionData.expiresAt && Date.now() > this.sessionData.expiresAt) {
      this.sessionData = null;
      return false;
    }

    // Intentar hacer una petición de prueba
    try {
      const cookieHeader = this.sessionData.cookies
        .map(c => `${c.name}=${c.value}`)
        .join('; ');

      const response = await fetch(`${this.baseUrl}/front/helpdesk.public.php`, {
        method: 'GET',
        headers: {
          'Cookie': cookieHeader,
          'Accept': 'text/html',
        },
        redirect: 'manual',
      });

      // Si redirige a login, la sesión expiró
      if (response.status === 302 || response.url.includes('login.php')) {
        console.log('🍪 Sesión de GLPI expiró (redirige a login)');
        this.sessionData = null;
        return false;
      }

      return response.ok;
    } catch (err) {
      console.error('Error al verificar sesión GLPI:', err);
      return false;
    }
  }

  async startMfaLogin(): Promise<{ success: boolean; error?: string }> {
    try {
      // Cerrar navegador anterior si existe
      await this.closeBrowser();

      console.log('🚀 Iniciando navegador para login con MFA...');
      console.log('   Ingresa usuario, contraseña y código MFA manualmente');
      console.log('   El sistema detectará automáticamente cuando inicies sesión');
      
      this.browser = await puppeteer.launch({
        headless: false, // Mostrar navegador para que usuario vea el login
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
        ],
      });

      this.page = await this.browser.newPage();
      
      // Configurar viewport
      await this.page.setViewport({ width: 1280, height: 800 });

      // Navegar a la página de login
      console.log('📍 Navegando a:', this.loginUrl);
      await this.page.goto(this.loginUrl, { waitUntil: 'networkidle2', timeout: 30000 });

      // Esperar a que el usuario complete el login
      console.log('⏳ Esperando que el usuario complete el login...');
      console.log('   1. Ingresa usuario y contraseña');
      console.log('   2. Ingresa el código MFA cuando lo recibas');
      console.log('   3. El sistema detectará cuando la sesión sea válida');

      // Esperar a que la URL cambie a central.php (login exitoso)
      // O que el usuario navegue fuera de login.php y mfa.form.php
      const maxAttempts = 300; // 5 minutos
      const pollInterval = 1000; // 1 segundo
      
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const currentUrl = this.page?.url() || '';
          
          // Verificar si ya no estamos en páginas de login/MFA
          const isNotLogin = !currentUrl.includes('login.php') && 
                            !currentUrl.includes('mfa.form.php') &&
                            !currentUrl.includes('MFA');
          
          // O si estamos en central.php (página principal de GLPI)
          const isCentral = currentUrl.includes('/front/central.php');
          
          if (isCentral || (isNotLogin && currentUrl.includes('/front/'))) {
            console.log(`✅ Login detectado después de ${attempt + 1} segundos`);
            console.log(`   URL actual: ${currentUrl}`);
            break;
          }
        } catch {
          // Ignorar errores de polling
        }
        
        await this.sleep(pollInterval);
        
        // Verificar si el usuario cerró la pestaña
        if (this.page?.isClosed()) {
          throw new Error('El usuario cerró la pestaña del navegador');
        }
      }
      
      // Verificar URL final
      const finalUrl = this.page?.url() || '';
      if (finalUrl.includes('login.php') || finalUrl.includes('mfa.form.php')) {
        await this.closeBrowser();
        return { success: false, error: 'Timeout: No se completó el login en 5 minutos' };
      }

      // Extraer todas las cookies
      const allCookies = await this.page.cookies();
      
      // Guardar sesión
      this.sessionData = {
        cookies: allCookies.map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite,
        })),
        createdAt: Date.now(),
        expiresAt: Date.now() + (24 * 60 * 60 * 1000), // 24 horas
      };

      await this.saveCookies();

      console.log('✅ Login completado exitosamente');
      console.log(`🍪 ${allCookies.length} cookies guardadas`);
      
      // Cerrar navegador
      await this.closeBrowser();

      return { success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error('❌ Error en startMfaLogin:', error);
      await this.closeBrowser();
      return { success: false, error };
    }
  }

  async submitMfaCode(code: string): Promise<{ success: boolean; error?: string }> {
    if (!this.page) {
      return { success: false, error: 'No hay sesión de navegador activa' };
    }

    try {
      // Buscar campo de MFA (puede variar según configuración de GLPI)
      const mfaInput = await this.page.$('input[name="auth_mfa_code"], input[name="mfa_code"], input[type="text"][placeholder*="código"], input[type="text"][placeholder*="code"]');
      
      if (!mfaInput) {
        return { success: false, error: 'No se encontró el campo de código MFA. ¿Ya estás en la página de MFA?' };
      }

      // Escribir código
      await mfaInput.type(code);
      
      // Buscar y hacer click en botón de submit
      const submitButton = await this.page.$('input[type="submit"], button[type="submit"]');
      if (submitButton) {
        await submitButton.click();
      } else {
        return { success: false, error: 'No se encontró el botón de enviar' };
      }

      // Esperar navegación
      await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });

      // Verificar si el login fue exitoso
      const currentUrl = this.page.url();
      if (currentUrl.includes('login.php')) {
        return { success: false, error: 'Código MFA incorrecto o expirado' };
      }

      // Extraer cookies
      const cookies = await this.page.cookies();
      
      this.sessionData = {
        cookies: cookies.map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
        })),
        createdAt: Date.now(),
        expiresAt: Date.now() + (24 * 60 * 60 * 1000),
      };

      await this.saveCookies();
      await this.closeBrowser();

      return { success: true };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return { success: false, error: error.message };
    }
  }

  async logout(): Promise<void> {
    this.sessionData = null;
    
    if (fs.existsSync(this.cookieFile)) {
      fs.unlinkSync(this.cookieFile);
    }
    
    await this.closeBrowser();
    
    console.log('🚪 Sesión de GLPI cerrada');
  }

  private async closeBrowser(): Promise<void> {
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // Ignorar errores al cerrar
      }
      this.browser = null;
      this.page = null;
    }
  }

  private getCookieHeader(): string {
    if (!this.sessionData) {
      return '';
    }
    return this.sessionData.cookies
      .map(c => `${c.name}=${c.value}`)
      .join('; ');
  }

  private async fetchWithCookies(url: string, options: RequestInit = {}): Promise<Response> {
    const cookieHeader = this.getCookieHeader();
    
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      ...(options.headers as Record<string, string> || {}),
    };
    
    if (cookieHeader) {
      headers['Cookie'] = cookieHeader;
    }

    return fetch(url, {
      ...options,
      headers,
      redirect: 'manual',
    });
  }

  async createTicket(title: string, content: string, categoryId: number, requesterId: string, assigneeId?: string): Promise<string | null> {
    if (!await this.isSessionValid()) {
      throw new Error('Sesión de GLPI no válida. Inicia sesión nuevamente.');
    }

    const payload = {
      input: {
        name: title,
        content: content,
        itilcategories_id: categoryId,
        _users_id_requester: Number.isNaN(Number(requesterId)) ? requesterId : Number(requesterId),
        ...(assigneeId && { _users_id_assign: Number.isNaN(Number(assigneeId)) ? assigneeId : Number(assigneeId) }),
      },
    };

    const response = await this.fetchWithCookies(`${this.baseUrl}/apirest.php/Ticket`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(`GLPI error: ${JSON.stringify(data)}`);
    }

    return data?.id ? String(data.id) : null;
  }

  async searchUsers(query: string): Promise<unknown[]> {
    if (!await this.isSessionValid()) {
      throw new Error('Sesión de GLPI no válida. Inicia sesión nuevamente.');
    }

    const params = new URLSearchParams({
      searchText: query,
      range: '0-50',
    });

    const response = await this.fetchWithCookies(`${this.baseUrl}/apirest.php/search/User?${params}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(`GLPI error: ${JSON.stringify(data)}`);
    }

    return Array.isArray(data) ? data : data?.data || [];
  }

  async findUsersByDni(dni: string): Promise<unknown[]> {
    return this.searchUsers(dni);
  }

  async findUsersByName(name: string): Promise<unknown[]> {
    return this.searchUsers(name);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getSessionStatus(): { isValid: boolean; expiresAt?: number; userId?: string } {
    if (!this.sessionData) {
      return { isValid: false };
    }
    return {
      isValid: true,
      expiresAt: this.sessionData.expiresAt,
      userId: this.sessionData.userId,
    };
  }
}
