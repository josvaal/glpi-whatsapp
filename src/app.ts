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

  startWhatsAppListener(
    config.whatsapp,
    async (message) => {
      const mediaTag =
        message.hasMedia && !message.body.startsWith("[media:")
          ? ` [media:${message.mediaType || "desconocido"}]`
          : "";
      console.log(
        `[${message.timestamp.toISOString()}] ${message.senderLabel}: ${message.body}${mediaTag}`
      );
      await flow.handleMessage(message);
    },
    async (vote) => {
      const selected = vote.selectedOptionNames.length > 0
        ? vote.selectedOptionNames.join(", ")
        : vote.selectedOptionIds.join(", ");
      console.log(
        `[${vote.timestamp.toISOString()}] ${vote.senderLabel}: [encuesta] ${selected}`
      );
      await flow.handlePollVote(vote);
    }
  );
}
