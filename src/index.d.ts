export declare const LogLevel: {
  readonly DEBUG: "DEBUG";
  readonly INFO: "INFO";
  readonly WARNING: "WARN";
  readonly ERROR: "ERROR";
  readonly FATAL: "FATAL";
};

export declare const ActorType: {
  readonly USER: "USER";
  readonly SERVICE: "SERVICE";
  readonly SYSTEM: "SYSTEM";
};

export type LogLevelValue = (typeof LogLevel)[keyof typeof LogLevel];
export type ActorTypeValue = (typeof ActorType)[keyof typeof ActorType];

export interface AppLogRequestData {
  source_service: string;
  environment: string;
  level: LogLevelValue;
  message: string;
  trace_id: string;
  created_at?: Date | string;
  context_json?: Record<string, unknown> | null;
}

export declare class AppLogRequest {
  source_service: string;
  environment: string;
  level: LogLevelValue;
  message: string;
  trace_id: string;
  created_at: string;
  context_json: Record<string, unknown> | null;
  constructor(data: AppLogRequestData);
  toJSON(): Record<string, unknown>;
}

export interface AuditLogRequestData {
  source_service: string;
  environment: string;
  action: string;
  actor_type: ActorTypeValue;
  target_resource: string;
  outcome: string;
  ip_address: string;
  event_time?: Date | string;
  actor_id?: string | null;
  detail_json?: Record<string, unknown> | null;
}

export declare class AuditLogRequest {
  source_service: string;
  environment: string;
  action: string;
  actor_type: ActorTypeValue;
  target_resource: string;
  outcome: string;
  ip_address: string;
  event_time: string;
  actor_id: string | null;
  detail_json: Record<string, unknown> | null;
  constructor(data: AuditLogRequestData);
  toJSON(): Record<string, unknown>;
}

export interface AppLogResponse {
  log_id: number;
  ingested_at: string;
}

export interface BatchLogResult {
  index: number;
  success: boolean;
  log_id: number | null;
  error_code: string | null;
  message: string | null;
}

export interface BatchAppLogResponse {
  results: BatchLogResult[];
  total: number;
  succeeded: number;
  failed: number;
}

export interface AuditLogResponse {
  log_id: number;
  ingested_at: string;
}

export interface LMSClientOptions {
  baseUrl: string;
  serviceId: string;
  secret: string;
  timeout?: number;
  maxRetries?: number;
}

export declare class LMSClient {
  serviceId: string;
  constructor(options: LMSClientOptions);
  logApp(request: AppLogRequest): Promise<AppLogResponse>;
  logAppBatch(requests: AppLogRequest[]): Promise<BatchAppLogResponse>;
  logAudit(request: AuditLogRequest): Promise<AuditLogResponse>;
  close(): void;
}

export declare class LMSError extends Error {
  statusCode: number | null;
  responseBody: Record<string, unknown>;
  constructor(message: string, statusCode?: number | null, responseBody?: Record<string, unknown>);
}
export declare class LMSAuthError extends LMSError {}
export declare class LMSRateLimitError extends LMSError {}
export declare class LMSValidationError extends LMSError {}
export declare class LMSConnectionError extends LMSError {}
