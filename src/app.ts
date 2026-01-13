import { loadConfig } from "./config";
import { GlpiClient } from "./glpi";
import { TicketFlow } from "./ticket-flow";
import { startWhatsAppListener } from "./whatsapp";

export async function run(): Promise<void> {
  const config = loadConfig();
  const glpi = new GlpiClient(config.glpi);
  const flow = new TicketFlow(glpi, {
    defaultCategoryId: config.defaultCategoryId,
    technicianByPhone: config.technicianByPhone,
  });

  startWhatsAppListener(config.whatsapp, async (message) => {
    console.log(
      `[${message.timestamp.toISOString()}] ${message.senderLabel}: ${message.body}`
    );
    await flow.handleMessage(message);
  });
}
