import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'glpi-whatsapp.db');

export type Technician = {
  id: number;
  whatsapp_id: string;
  phone: string;
  name: string | null;
  glpi_id: string | null;
  created_at: string;
};

export type TicketRecord = {
  id: number;
  ticket_id: string;
  requester_id: number | null;
  assignee_id: number | null;
  subject: string | null;
  description: string | null;
  status: string;
  created_at: string;
};

export class AppDatabase {
  private db: Database.Database;

  constructor() {
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.initializeTables();
    console.log(`✅ Base de datos SQLite inicializada: ${DB_PATH}`);
  }

  private initializeTables(): void {
    // Tabla de técnicos registrados
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS technicians (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        whatsapp_id TEXT UNIQUE NOT NULL,
        phone TEXT NOT NULL,
        name TEXT,
        glpi_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Tabla de tickets
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id TEXT UNIQUE NOT NULL,
        requester_id INTEGER,
        assignee_id INTEGER,
        subject TEXT,
        description TEXT,
        status TEXT DEFAULT 'open',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (requester_id) REFERENCES technicians(id),
        FOREIGN KEY (assignee_id) REFERENCES technicians(id)
      )
    `);

    // Índice para búsquedas rápidas
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_technicians_whatsapp ON technicians(whatsapp_id)
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tickets_ticket_id ON tickets(ticket_id)
    `);

    console.log('📊 Tablas creadas: technicians, tickets');
  }

  // ========== TÉCNICOS ==========

  getTechnicianByWhatsAppId(whatsappId: string): Technician | null {
    const stmt = this.db.prepare('SELECT * FROM technicians WHERE whatsapp_id = ?');
    return stmt.get(whatsappId) as Technician | null;
  }

  getTechnicianByPhone(phone: string): Technician | null {
    const stmt = this.db.prepare('SELECT * FROM technicians WHERE phone = ?');
    return stmt.get(phone) as Technician | null;
  }

  registerTechnician(whatsappId: string, phone: string, name?: string | null, glpiId?: string | null): Technician {
    const stmt = this.db.prepare(`
      INSERT INTO technicians (whatsapp_id, phone, name, glpi_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(whatsapp_id) DO UPDATE SET
        phone = excluded.phone,
        name = excluded.name,
        glpi_id = excluded.glpi_id
    `);
    
    stmt.run(whatsappId, phone, name || null, glpiId || null);
    
    return this.getTechnicianByWhatsAppId(whatsappId)!;
  }

  updateTechnicianGLPI(whatsappId: string, glpiId: string): void {
    const stmt = this.db.prepare(`
      UPDATE technicians SET glpi_id = ? WHERE whatsapp_id = ?
    `);
    stmt.run(glpiId, whatsappId);
  }

  getAllTechnicians(): Technician[] {
    const stmt = this.db.prepare('SELECT * FROM technicians ORDER BY created_at DESC');
    return stmt.all() as Technician[];
  }

  deleteTechnician(whatsappId: string): boolean {
    const stmt = this.db.prepare('DELETE FROM technicians WHERE whatsapp_id = ?');
    const result = stmt.run(whatsappId);
    return result.changes > 0;
  }

  // ========== TICKETS ==========

  createTicket(
    ticketId: string,
    requesterId: number | null,
    assigneeId: number | null,
    subject?: string | null,
    description?: string | null
  ): TicketRecord {
    const stmt = this.db.prepare(`
      INSERT INTO tickets (ticket_id, requester_id, assignee_id, subject, description)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    stmt.run(ticketId, requesterId, assigneeId, subject || null, description || null);
    
    return this.getTicketByTicketId(ticketId)!;
  }

  getTicketByTicketId(ticketId: string): TicketRecord | null {
    const stmt = this.db.prepare('SELECT * FROM tickets WHERE ticket_id = ?');
    return stmt.get(ticketId) as TicketRecord | null;
  }

  updateTicketStatus(ticketId: string, status: string): boolean {
    const stmt = this.db.prepare(`
      UPDATE tickets SET status = ? WHERE ticket_id = ?
    `);
    const result = stmt.run(status, ticketId);
    return result.changes > 0;
  }

  getTicketsByTechnician(technicianId: number, role: 'requester' | 'assignee' | 'all' = 'all'): TicketRecord[] {
    let query = 'SELECT * FROM tickets WHERE ';
    
    if (role === 'requester') {
      query += 'requester_id = ?';
    } else if (role === 'assignee') {
      query += 'assignee_id = ?';
    } else {
      query += '(requester_id = ? OR assignee_id = ?)';
    }
    
    query += ' ORDER BY created_at DESC';
    
    const stmt = this.db.prepare(query);
    
    if (role === 'all') {
      return stmt.all(technicianId, technicianId) as TicketRecord[];
    } else {
      return stmt.all(technicianId) as TicketRecord[];
    }
  }

  getAllTickets(): TicketRecord[] {
    const stmt = this.db.prepare('SELECT * FROM tickets ORDER BY created_at DESC');
    return stmt.all() as TicketRecord[];
  }

  // ========== ESTADÍSTICAS ==========

  getStats(): {
    totalTechnicians: number;
    totalTickets: number;
    openTickets: number;
    closedTickets: number;
  } {
    const techStmt = this.db.prepare('SELECT COUNT(*) as count FROM technicians');
    const ticketStmt = this.db.prepare('SELECT COUNT(*) as count FROM tickets');
    const openStmt = this.db.prepare("SELECT COUNT(*) as count FROM tickets WHERE status = 'open'");
    const closedStmt = this.db.prepare("SELECT COUNT(*) as count FROM tickets WHERE status = 'closed'");

    return {
      totalTechnicians: (techStmt.get() as any).count,
      totalTickets: (ticketStmt.get() as any).count,
      openTickets: (openStmt.get() as any).count,
      closedTickets: (closedStmt.get() as any).count,
    };
  }

  // ========== CERRAR CONEXIÓN ==========

  close(): void {
    this.db.close();
    console.log('🔒 Base de datos cerrada');
  }
}

// Singleton instance
let dbInstance: AppDatabase | null = null;

export function getDatabase(): AppDatabase {
  if (!dbInstance) {
    dbInstance = new AppDatabase();
  }
  return dbInstance;
}
