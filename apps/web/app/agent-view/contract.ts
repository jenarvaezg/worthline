export interface AgentViewEnvelope<T> {
  data: T;
  meta?: Record<string, unknown>;
  links?: Record<string, string>;
}

export interface AgentViewErrorEnvelope {
  error: {
    code: AgentViewErrorCode;
    message: string;
    details?: unknown;
  };
}

export type AgentViewErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "unprocessable_entity"
  | "internal_error";

export type AgentViewScopeType = "household" | "member" | "group";

export interface AgentViewObjectReference {
  id: string;
  object: "member" | "member_group" | "scope";
  label: string;
}

export interface AgentViewScope {
  id: string;
  object: "scope";
  type: AgentViewScopeType;
  label: string;
  members: AgentViewObjectReference[];
  isDefault: boolean;
}

export class AgentViewHttpError extends Error {
  readonly code: AgentViewErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(params: {
    code: AgentViewErrorCode;
    message: string;
    status: number;
    details?: unknown;
  }) {
    super(params.message);
    this.name = "AgentViewHttpError";
    this.code = params.code;
    this.status = params.status;
    this.details = params.details;
  }
}

export function successEnvelope<T>(data: T): AgentViewEnvelope<T> {
  return { data };
}

export function errorEnvelope(error: AgentViewHttpError): AgentViewErrorEnvelope {
  return {
    error: {
      code: error.code,
      ...(error.details === undefined ? {} : { details: error.details }),
      message: error.message,
    },
  };
}
