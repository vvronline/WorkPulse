/**
 * Notification Payload Validator
 * 
 * Validates required fields in FCM payloads before routing.
 * Prevents silent failures and provides structured error logging.
 * 
 * Problem it solves:
 * - Server sends invalid payloads → silent failures with zero visibility
 * - App doesn't validate before routing → no error signals
 * - Result: 0% error visibility; impossible to debug
 * - Fixes: All invalid payloads logged with reason + error hash
 */

import { notificationLogger } from './notificationLogger';

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export interface NotificationRoute {
  type: 'call' | 'message';
  conversationId: string;
  messageId?: string;
  callId?: string;
  dedupeKey: string;
  sentAt?: string;
  timestamp: number;
}

export interface ValidationError {
  ok: false;
  reason: string;
  missing: string[];
  invalid: string[];
}

export interface ValidationSuccess {
  ok: true;
  data: NotificationRoute;
}

export type ValidationResult = ValidationSuccess | ValidationError;

// ============================================================================
// REQUIRED FIELDS BY NOTIFICATION TYPE
// ============================================================================

const MESSAGE_REQUIRED_FIELDS = [
  'type',
  'conversationId',
  'messageId',
  'senderName',
  'dedupeKey',
];

const MESSAGE_OPTIONAL_FIELDS = [
  'messagePreview',
  'senderAvatar',
  'sentAt',
  'isGroup',
];

const CALL_REQUIRED_FIELDS = [
  'type',
  'conversationId',
  'callId',
  'callerId',
  'callerName',
  'dedupeKey',
];

const CALL_OPTIONAL_FIELDS = [
  'callerAvatar',
  'expiresAt',
  'isGroup',
  'groupName',
];

// General app alerts (task assigned, leave approved, mention, meeting, ...).
// The server sends these DATA-ONLY with an arbitrary type (default
// 'notification') plus title/body/dedupeKey. They carry no conversationId.
const ALERT_REQUIRED_FIELDS = [
  'type',
  'title',
  'body',
  'dedupeKey',
];

// ============================================================================
// NOTIFICATION PAYLOAD VALIDATOR
// ============================================================================

export class NotificationPayloadValidator {
  /**
   * Validate a FCM payload and return a typed route or error
   * 
   * @param payload - Raw FCM payload from Firebase
   * @param context - Context for logging (background, foreground, tap)
   * @returns ValidationResult with either valid route or error details
   */
  static validate(payload: any, context: string = 'background'): ValidationResult {
    try {
      // 1. Check that payload exists
      if (!payload || typeof payload !== 'object') {
        return {
          ok: false,
          reason: 'Payload is not an object',
          missing: [],
          invalid: [],
        };
      }

      // 2. Determine notification type. Keep this aligned with
      // server/services/pushNotifications.ts: Android data pushes use
      // incoming_call, chat_message, call_handled_elsewhere, and arbitrary alert
      // types (default 'notification').
      const rawType = payload.type as string | undefined;
      if (!rawType) {
        return {
          ok: false,
          reason: 'Missing notification type',
          missing: ['type'],
          invalid: [],
        };
      }

      const type: 'call' | 'message' | 'alert' =
        rawType === 'call' || rawType === 'incoming_call'
          ? 'call'
          : rawType === 'message' || rawType === 'chat_message'
            ? 'message'
            : 'alert';

      // 3. Validate required fields based on type
      const requiredFields =
        type === 'call'
          ? CALL_REQUIRED_FIELDS
          : type === 'message'
            ? MESSAGE_REQUIRED_FIELDS
            : ALERT_REQUIRED_FIELDS;
      const missingFields = requiredFields.filter(field => !payload[field]);
      const invalidFields = this.checkInvalidFields(payload, type);

      if (missingFields.length > 0 || invalidFields.length > 0) {
        const dedupeKey = payload.dedupeKey || 'UNKNOWN';
        const error: ValidationError = {
          ok: false,
          reason: `Validation failed for ${type} notification`,
          missing: missingFields,
          invalid: invalidFields,
        };

        // Log the error
        this.logValidationError(dedupeKey, type, error, context);

        return error;
      }

      // 4. Create typed route object
      const route: NotificationRoute = {
        type: type === 'call' ? 'call' : 'message',
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        callId: payload.callId,
        dedupeKey: payload.dedupeKey,
        sentAt: payload.sentAt,
        timestamp: Date.now(),
      };

      // 5. Validate field formats
      const formatErrors = type === 'alert' ? [] : this.validateFieldFormats(route, type);
      if (formatErrors.length > 0) {
        const error: ValidationError = {
          ok: false,
          reason: `Field format validation failed`,
          missing: [],
          invalid: formatErrors,
        };

        this.logValidationError(route.dedupeKey, type, error, context);
        return error;
      }

      // 6. Log successful validation
      notificationLogger.info('payload_validation_success', {
        source: context,
        dedupeKey: route.dedupeKey,
        conversationId: route.conversationId,
        metadata: { type, rawType },
      });

      return {
        ok: true,
        data: route,
      };
    } catch (error) {
      // Unexpected error during validation
      const errorMessage = error instanceof Error ? error.message : String(error);
      notificationLogger.error('payload_validation_unexpected_error', error instanceof Error ? error : String(error), {
        source: context,
        metadata: { errorMessage },
      });

      return {
        ok: false,
        reason: `Unexpected validation error: ${errorMessage}`,
        missing: [],
        invalid: [],
      };
    }
  }

  /**
   * Validate and normalize a payload (combine validate + normalization)
   * Returns structured NotificationRoute on success
   */
  static validateAndNormalize(payload: any, context: string = 'background'): NotificationRoute | null {
    const result = this.validate(payload, context);
    if (result.ok) {
      return result.data;
    }
    return null;
  }

  /**
   * Check for invalid field values
   */
  private static checkInvalidFields(payload: any, type: string): string[] {
    const invalid: string[] = [];

    // Check conversationId format
    if (payload.conversationId) {
      if (typeof payload.conversationId !== 'string') {
        invalid.push('conversationId (must be string)');
      }
      if (payload.conversationId.trim().length === 0) {
        invalid.push('conversationId (must be non-empty)');
      }
    }

    // Check dedupeKey format
    if (payload.dedupeKey) {
      if (typeof payload.dedupeKey !== 'string') {
        invalid.push('dedupeKey (must be string)');
      }
      if (!payload.dedupeKey.includes(':')) {
        invalid.push('dedupeKey (must contain colon separator)');
      }
    }

    // Type-specific validations
    if (type === 'message') {
      if (payload.messageId && typeof payload.messageId !== 'string') {
        invalid.push('messageId (must be string)');
      }
      if (payload.senderName && typeof payload.senderName !== 'string') {
        invalid.push('senderName (must be string)');
      }
      if (payload.senderName && payload.senderName.trim().length === 0) {
        invalid.push('senderName (must be non-empty)');
      }
    } else if (type === 'call') {
      if (payload.callId && typeof payload.callId !== 'string') {
        invalid.push('callId (must be string)');
      }
      if (payload.callerId && typeof payload.callerId !== 'string') {
        invalid.push('callerId (must be string)');
      }
      if (payload.callerName && typeof payload.callerName !== 'string') {
        invalid.push('callerName (must be string)');
      }
    }

    return invalid;
  }

  /**
   * Validate field formats (timestamps, IDs, etc)
   */
  private static validateFieldFormats(
    route: NotificationRoute,
    type: string
  ): string[] {
    const errors: string[] = [];

    // Validate sentAt if present
    if (route.sentAt) {
      try {
        const date = new Date(route.sentAt);
        if (isNaN(date.getTime())) {
          errors.push('sentAt (invalid ISO timestamp)');
        }
      } catch {
        errors.push('sentAt (failed to parse as date)');
      }
    }

    // Validate IDs are not empty
    if (type === 'message' && !route.messageId) {
      errors.push('messageId (empty)');
    }
    if (type === 'call' && !route.callId) {
      errors.push('callId (empty)');
    }

    // Validate conversationId matches expected pattern
    // (simple check: should not be empty, should be alphanumeric + underscore)
    if (!/^[a-zA-Z0-9_-]+$/.test(route.conversationId)) {
      errors.push('conversationId (invalid format)');
    }

    return errors;
  }

  /**
   * Log a validation error with structured format
   */
  private static logValidationError(
    dedupeKey: string,
    type: string,
    error: ValidationError,
    context: string
  ): void {
    const errorSummary = [
      ...(error.missing.length > 0 ? [`Missing: ${error.missing.join(', ')}`] : []),
      ...(error.invalid.length > 0 ? [`Invalid: ${error.invalid.join(', ')}`] : []),
    ].join(' | ');

    notificationLogger.warn('payload_validation_failure', {
      source: context,
      dedupeKey,
      metadata: {
        type,
        reason: error.reason,
        missing: error.missing,
        invalid: error.invalid,
        summary: errorSummary,
      },
    });
  }

  /**
   * Get required fields for a notification type
   */
  static getRequiredFields(type: 'call' | 'message'): string[] {
    return type === 'call' ? CALL_REQUIRED_FIELDS : MESSAGE_REQUIRED_FIELDS;
  }

  /**
   * Get optional fields for a notification type
   */
  static getOptionalFields(type: 'call' | 'message'): string[] {
    return type === 'call' ? CALL_OPTIONAL_FIELDS : MESSAGE_OPTIONAL_FIELDS;
  }

  /**
   * Get all expected fields for a notification type
   */
  static getAllFields(type: 'call' | 'message'): string[] {
    const required = this.getRequiredFields(type);
    const optional = this.getOptionalFields(type);
    return [...required, ...optional];
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export const notificationPayloadValidator = NotificationPayloadValidator;

/**
 * Helper function for common validation pattern
 */
export function validateNotificationPayload(
  payload: any,
  context?: string
): NotificationRoute | null {
  const result = NotificationPayloadValidator.validate(payload, context);
  return result.ok ? result.data : null;
}
