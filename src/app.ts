import { loadCategories } from "./categories";
import { loadConfig } from "./config";
import { GlpiClient } from "./glpi";
import { TicketFlow } from "./ticket-flow";
import { startWhatsAppListener } from "./whatsapp";

export async function run(): Promise<void> {
  const config = loadConfig();
  const glpi = new GlpiClient(config.glpi);
  const categories = loadCategories(config.categoriesPath);
  const defaultCategoryName =
    categories.find(
      (entry) => entry.glpiCategoryId === config.defaultCategoryId
    )?.category ?? undefined;
  const flow = new TicketFlow(glpi, {
    defaultCategoryId: config.defaultCategoryId,
    defaultCategoryName,
    techniciansByPhone: config.techniciansByPhone,
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
      try {
        await flow.handleMessage(message);
      } catch (err) {
        const messageText = err instanceof Error ? err.message : String(err);
        console.error(`Error al procesar mensaje: ${messageText}`);
        try {
          await message.reply(
            "Ocurrio un error al procesar el ticket en GLPI. Intenta nuevamente o contacta al administrador."
          );
        } catch {
          // ignore reply failures
        }
      }
    },
    async (vote) => {
      const selected = vote.selectedOptionNames.length > 0
        ? vote.selectedOptionNames.join(", ")
        : vote.selectedOptionIds.join(", ");
      console.log(
        `[${vote.timestamp.toISOString()}] ${vote.senderLabel}: [encuesta] ${selected}`
      );
      try {
        await flow.handlePollVote(vote);
      } catch (err) {
        const messageText = err instanceof Error ? err.message : String(err);
        console.error(`Error al procesar encuesta: ${messageText}`);
        try {
          await vote.reply(
            "Ocurrio un error al procesar la encuesta. Intenta nuevamente."
          );
        } catch {
          // ignore reply failures
        }
      }
    }
  );
}
