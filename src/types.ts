export type CategoryEntry = {
  category: string;
  glpiCategoryId?: number;
  keywords?: string[];
  defaultPriority?: string;
  [key: string]: unknown;
};

export type GlpiUserCandidate = {
  id: string;
  login: string;
  firstname: string;
  realname: string;
};

export type IncomingMessage = {
  body: string;
  timestamp: Date;
  senderLabel: string;
  senderId: string | null;
  senderNumber: string | null;
  chatId: string;
  hasMedia: boolean;
  mediaType: string | null;
  getMedia: () => Promise<MediaPayload | null>;
  reply: (text: string) => Promise<void>;
};

export type MediaPayload = {
  data: string;
  mimetype: string;
  filename: string | null;
};

export type TicketDraft = {
  solicitante?: string;
  asignado?: string;
  problema?: string;
  rawText: string;
  isComplete: boolean;
};
