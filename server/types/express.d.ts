import "express";
import type { Logger } from "pino";

declare global {
  namespace Express {
    interface Request {
      id?: string;
      log: Logger;
      enrichLogger?: () => void;
      isMasterRoute?: boolean;
      tenant?: {
        id: number;
        slug: string;
        plan?: string;
        features?: unknown;
        [key: string]: unknown;
      };
      tenantId?: number | string;
      userId?: number;
      userOrgId?: number | null;
      userTeamId?: number | null;
      userRole?: string;
      roleLevel?: number;
      username?: string;
      sessionId?: string;
      isImpersonated?: boolean;
      impersonatedBy?: number;
      impersonatedTenantName?: string | null;
      isPlatformUser?: boolean;
      user?: Record<string, unknown>;
      db?: {
        query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number; [key: string]: unknown }>;
        transaction?: (fn: (client: unknown) => Promise<unknown>) => Promise<unknown>;
        [key: string]: unknown;
      };
      tenantPool?: unknown;
      tenantQuery?: (sql: string, params?: unknown[]) => Promise<unknown>;
      tenantTransaction?: (fn: (client: unknown) => Promise<unknown>) => Promise<unknown>;
      file?: Express.Multer.File;
      files?:
        | Express.Multer.File[]
        | { [fieldname: string]: Express.Multer.File[] };
    }
  }
}

export {};