import type { ChatToolCall } from '@freellmapi/shared/types.js';
import type { RouteResult } from '../services/router.js';

export interface InboundChatResult {
  route: RouteResult;
  text: string;
  reasoning: string;
  toolCalls: ChatToolCall[];
  finishReason: string | null;
  promptTokens: number;
  completionTokens: number;
}
