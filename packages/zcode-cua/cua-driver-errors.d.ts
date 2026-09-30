export declare class CuaBrokerError extends Error {
  code: string;
  actionSent: boolean;
  details?: unknown;
  constructor(
    message: string,
    options?: { code?: string; actionSent?: boolean; details?: unknown },
  );
}

export type CuaDeliveryState = "not_sent" | "sent" | "possibly_sent" | "unknown";
export type CuaVerificationState =
  | "not_run"
  | "observed_change"
  | "expected_state_confirmed"
  | "inconclusive";

export interface CuaDriverEnvelope {
  parsed: Record<string, unknown>;
  isError: boolean;
  structured: Record<string, any>;
  texts: string[];
  images: Array<{ type: "image"; data?: string; dataBase64?: string; mimeType?: string }>;
}

export declare function brokerCodeForDriverCode(code: unknown): string;
export declare const KNOWN_BROKER_CODES: readonly string[];
export declare function textBlock(text: string): { type: "text"; text: string };
export declare function jsonBlock(value: unknown): { type: "text"; text: string };
export declare function imageBlock(
  base64: string,
  mimeType: string,
): {
  type: "image";
  data: string;
  mimeType: string;
};
export declare function jsonSafe(value: unknown, depth?: number): unknown;
export declare function okResult(input?: { content?: unknown[]; structuredContent?: unknown }): {
  content: unknown[];
  structuredContent?: unknown;
};
export declare function errorResult(input: {
  code: string;
  message: string;
  actionSent?: boolean;
  details?: unknown;
}): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError: true;
};
export declare function readDriverEnvelope(rawJson: unknown): CuaDriverEnvelope;
export declare function refusalOf(
  envelope: CuaDriverEnvelope,
): { code: string; message: string } | undefined;
export declare function actionDelivered(envelope: CuaDriverEnvelope): boolean;
export declare function deliveryState(input: {
  delivered: boolean;
  aborted: boolean;
  refused: boolean;
}): CuaDeliveryState;
export declare function verificationStateForEffect(effect: unknown): CuaVerificationState;
