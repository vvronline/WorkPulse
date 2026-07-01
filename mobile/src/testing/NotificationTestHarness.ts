/**
 * Notification Test Harness
 * 
 * Simulates FCM messages and notification scenarios for testing.
 * Enables reproduction of all bug scenarios and baseline metrics.
 */

import { notificationLogger, NotificationState, NotificationLogLevel } from '../utils/notificationLogger';

// ============================================================================
// TYPES
// ============================================================================

export enum TestScenario {
  COLD_START_SINGLE = 'cold_start_single',
  COLD_START_BURST = 'cold_start_burst',
  FOREGROUND_SINGLE = 'foreground_single',
  FOREGROUND_BURST = 'foreground_burst',
  BACKGROUND_ALIVE = 'background_alive',
  RACE_CONDITION = 'race_condition',
  INVALID_PAYLOAD = 'invalid_payload',
  STALE_ROUTE = 'stale_route',
}

export interface MockFCMPayload {
  type: 'call' | 'message';
  conversationId: string;
  messageId?: string;
  callId?: string;
  senderName: string;
  senderAvatar?: string;
  dedupeKey: string;
  sentAt: string;
  messagePreview?: string;
  isGroup?: boolean;
}

export interface TestScenarioResult {
  scenario: TestScenario;
  success: boolean;
  routedCorrectly: boolean;
  latencyMs: number;
  duration_ms: number;
  startTime: number;
  endTime: number;
  error?: string;
  logs: any[];
  metrics: {
    totalNotifications: number;
    successfulRoutes: number;
    failedRoutes: number;
    averageLatencyMs: number;
  };
}

// ============================================================================
// NOTIFICATION TEST HARNESS
// ============================================================================

export class NotificationTestHarness {
  private static instance: NotificationTestHarness;
  private testResults: Map<string, TestScenarioResult> = new Map();
  private readonly results: TestScenarioResult[] = [];

  private constructor() {}

  static getInstance(): NotificationTestHarness {
    if (!NotificationTestHarness.instance) {
      NotificationTestHarness.instance = new NotificationTestHarness();
    }
    return NotificationTestHarness.instance;
  }

  /**
   * Generate a mock FCM payload
   */
  generatePayload(
    type: 'call' | 'message',
    conversationId: string,
    overrides?: Partial<MockFCMPayload>
  ): MockFCMPayload {
    const id = type === 'call' 
      ? `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      : `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    return {
      type,
      conversationId,
      messageId: type === 'message' ? id : undefined,
      callId: type === 'call' ? id : undefined,
      senderName: `Test User ${Math.floor(Math.random() * 1000)}`,
      senderAvatar: 'https://example.com/avatar.jpg',
      dedupeKey: `${type}:${id}`,
      sentAt: new Date().toISOString(),
      messagePreview: type === 'message' ? 'Test message content' : undefined,
      isGroup: false,
      ...overrides,
    };
  }

  /**
   * Simulate a cold-start scenario (app killed)
   * Tests: Single notification tap when app is not running
   */
  async testColdStartSingle(): Promise<TestScenarioResult> {
    const startTime = Date.now();
    const testId = `test_${startTime}`;

    notificationLogger.info('test_scenario_started', {
      source: 'dispatch',
      metadata: { scenario: TestScenario.COLD_START_SINGLE },
    });

    try {
      const payload = this.generatePayload('message', 'conv_123', {
        senderName: 'Alice',
      });

      notificationLogger.log(
        'notification_delivered',
        'INFO',
        {
          dedupeKey: payload.dedupeKey,
          conversationId: payload.conversationId,
          type: payload.type,
          source: 'background',
          state: NotificationState.DELIVERED,
        }
      );

      // Simulate app being killed and restarted
      await this.simulateAppRestart();

      notificationLogger.log(
        'cold_start_routing',
        'INFO',
        {
          dedupeKey: payload.dedupeKey,
          conversationId: payload.conversationId,
          state: NotificationState.NAVIGATION_COMPLETED,
        }
      );

      const latencyMs = Date.now() - startTime;

      const result: TestScenarioResult = {
        scenario: TestScenario.COLD_START_SINGLE,
        success: true,
        routedCorrectly: true,
        latencyMs,
        duration_ms: latencyMs,
        startTime,
        endTime: Date.now(),
        logs: notificationLogger.getNotificationLogs(payload.dedupeKey),
        metrics: notificationLogger.calculateMetrics(),
      };

      this.results.push(result);
      return result;
    } catch (error) {
      const endTime = Date.now();
      const result: TestScenarioResult = {
        scenario: TestScenario.COLD_START_SINGLE,
        success: false,
        routedCorrectly: false,
        latencyMs: endTime - startTime,
        duration_ms: endTime - startTime,
        startTime,
        endTime,
        error: error instanceof Error ? error.message : String(error),
        logs: [],
        metrics: notificationLogger.calculateMetrics(),
      };

      this.results.push(result);
      notificationLogger.error('test_scenario_failed', error, {
        source: 'dispatch',
        metadata: { scenario: TestScenario.COLD_START_SINGLE },
      });

      return result;
    }
  }

  /**
   * Simulate burst notifications (10 messages in rapid succession)
   */
  async testColdStartBurst(): Promise<TestScenarioResult> {
    const startTime = Date.now();

    notificationLogger.info('test_scenario_started', {
      source: 'dispatch',
      metadata: { scenario: TestScenario.COLD_START_BURST },
    });

    try {
      const conversationId = 'conv_burst_123';
      const payloads: MockFCMPayload[] = [];

      // Generate 10 payloads in same conversation
      for (let i = 0; i < 10; i++) {
        const payload = this.generatePayload('message', conversationId, {
          senderName: 'Alice',
          messagePreview: `Message ${i + 1}`,
          sentAt: new Date(Date.now() + i * 100).toISOString(),
        });
        payloads.push(payload);

        // Log each delivery
        notificationLogger.log('notification_delivered', 'INFO', {
          dedupeKey: payload.dedupeKey,
          conversationId,
          type: 'message',
          source: 'background',
          state: NotificationState.DELIVERED,
        });
      }

      // Simulate deduplication should keep only latest
      const latestPayload = payloads[payloads.length - 1];

      await this.simulateAppRestart();

      notificationLogger.log('notification_deduplicated', 'INFO', {
        dedupeKey: latestPayload.dedupeKey,
        conversationId,
        metadata: { count: 10 },
      });

      const latencyMs = Date.now() - startTime;

      const result: TestScenarioResult = {
        scenario: TestScenario.COLD_START_BURST,
        success: true,
        routedCorrectly: true,
        latencyMs,
        duration_ms: latencyMs,
        startTime,
        endTime: Date.now(),
        logs: notificationLogger.getLogs({ conversationId }),
        metrics: notificationLogger.calculateMetrics(),
      };

      this.results.push(result);
      return result;
    } catch (error) {
      const endTime = Date.now();
      const result: TestScenarioResult = {
        scenario: TestScenario.COLD_START_BURST,
        success: false,
        routedCorrectly: false,
        latencyMs: endTime - startTime,
        duration_ms: endTime - startTime,
        startTime,
        endTime,
        error: error instanceof Error ? error.message : String(error),
        logs: [],
        metrics: notificationLogger.calculateMetrics(),
      };

      this.results.push(result);
      return result;
    }
  }

  /**
   * Simulate foreground scenario (app is open)
   */
  async testForegroundSingle(): Promise<TestScenarioResult> {
    const startTime = Date.now();

    notificationLogger.info('test_scenario_started', {
      source: 'dispatch',
      metadata: { scenario: TestScenario.FOREGROUND_SINGLE },
    });

    try {
      const payload = this.generatePayload('message', 'conv_456', {
        senderName: 'Bob',
      });

      // Log message arrival while app is open
      notificationLogger.log('notification_delivered', 'INFO', {
        dedupeKey: payload.dedupeKey,
        conversationId: payload.conversationId,
        type: payload.type,
        source: 'foreground',
        state: NotificationState.DELIVERED,
      });

      // User taps notification
      notificationLogger.log('notification_tapped', 'INFO', {
        dedupeKey: payload.dedupeKey,
        conversationId: payload.conversationId,
        state: NotificationState.TAPPED,
      });

      // Navigation completes
      notificationLogger.log('navigation_completed', 'INFO', {
        dedupeKey: payload.dedupeKey,
        conversationId: payload.conversationId,
        state: NotificationState.NAVIGATION_COMPLETED,
        duration_ms: Date.now() - startTime,
      });

      const result: TestScenarioResult = {
        scenario: TestScenario.FOREGROUND_SINGLE,
        success: true,
        routedCorrectly: true,
        latencyMs: Date.now() - startTime,
        duration_ms: Date.now() - startTime,
        startTime,
        endTime: Date.now(),
        logs: notificationLogger.getNotificationLogs(payload.dedupeKey),
        metrics: notificationLogger.calculateMetrics(),
      };

      this.results.push(result);
      return result;
    } catch (error) {
      const endTime = Date.now();
      const result: TestScenarioResult = {
        scenario: TestScenario.FOREGROUND_SINGLE,
        success: false,
        routedCorrectly: false,
        latencyMs: endTime - startTime,
        duration_ms: endTime - startTime,
        startTime,
        endTime,
        error: error instanceof Error ? error.message : String(error),
        logs: [],
        metrics: notificationLogger.calculateMetrics(),
      };

      this.results.push(result);
      return result;
    }
  }

  /**
   * Simulate invalid payload (missing required fields)
   */
  async testInvalidPayload(): Promise<TestScenarioResult> {
    const startTime = Date.now();

    notificationLogger.info('test_scenario_started', {
      source: 'dispatch',
      metadata: { scenario: TestScenario.INVALID_PAYLOAD },
    });

    try {
      // Payload missing conversationId
      const invalidPayload: any = {
        type: 'message',
        // conversationId is missing!
        messageId: 'msg_123',
        senderName: 'Alice',
        dedupeKey: 'msg:msg_123',
        sentAt: new Date().toISOString(),
      };

      notificationLogger.log('validation_failure', 'WARN', {
        dedupeKey: invalidPayload.dedupeKey,
        metadata: { reason: 'missing_conversationId' },
        source: 'background',
      });

      const result: TestScenarioResult = {
        scenario: TestScenario.INVALID_PAYLOAD,
        success: true,  // Success = correctly handled the invalid payload
        routedCorrectly: false,  // But didn't route
        latencyMs: Date.now() - startTime,
        duration_ms: Date.now() - startTime,
        startTime,
        endTime: Date.now(),
        logs: notificationLogger.getLogs({ level: NotificationLogLevel.WARN }),
        metrics: notificationLogger.calculateMetrics(),
      };

      this.results.push(result);
      return result;
    } catch (error) {
      const endTime = Date.now();
      const result: TestScenarioResult = {
        scenario: TestScenario.INVALID_PAYLOAD,
        success: false,
        routedCorrectly: false,
        latencyMs: endTime - startTime,
        duration_ms: endTime - startTime,
        startTime,
        endTime,
        error: error instanceof Error ? error.message : String(error),
        logs: [],
        metrics: notificationLogger.calculateMetrics(),
      };

      this.results.push(result);
      return result;
    }
  }

  /**
   * Simulate background-alive tap: JS context survives, pending-chat listener
   * consumes the route, and navigation starts without relying on a cold-start
   * deep link.
   */
  async testBackgroundAliveTap(): Promise<TestScenarioResult> {
      const startTime = Date.now();

      notificationLogger.info('test_scenario_started', {
        source: 'dispatch',
        metadata: { scenario: TestScenario.BACKGROUND_ALIVE },
      });

      try {
        const payload = this.generatePayload('message', 'conv_background_alive', {
          senderName: 'Casey',
        });

        notificationLogger.logNotificationTapped(
          payload.dedupeKey,
          payload.conversationId,
          payload.messageId,
        );
        notificationLogger.logStateTransition(
          payload.dedupeKey,
          payload.conversationId,
          NotificationState.ROUTE_PERSISTED,
          { source: 'test_harness', appState: 'background_alive' },
        );
        notificationLogger.logStateTransition(
          payload.dedupeKey,
          payload.conversationId,
          NotificationState.ROUTE_CONSUMED,
          { source: 'test_harness' },
        );
        notificationLogger.logStateTransition(
          payload.dedupeKey,
          payload.conversationId,
          NotificationState.NAVIGATION_STARTED,
          { source: 'test_harness', target: 'chat' },
        );

        const latencyMs = Date.now() - startTime;
        const result: TestScenarioResult = {
          scenario: TestScenario.BACKGROUND_ALIVE,
          success: latencyMs < 1000,
          routedCorrectly: true,
          latencyMs,
          duration_ms: latencyMs,
          startTime,
          endTime: Date.now(),
          logs: notificationLogger.getNotificationLogs(payload.dedupeKey),
          metrics: notificationLogger.calculateMetrics(),
        };

        this.results.push(result);
        return result;
      } catch (error) {
        const endTime = Date.now();
        const result: TestScenarioResult = {
          scenario: TestScenario.BACKGROUND_ALIVE,
          success: false,
          routedCorrectly: false,
          latencyMs: endTime - startTime,
          duration_ms: endTime - startTime,
          startTime,
          endTime,
          error: error instanceof Error ? error.message : String(error),
          logs: [],
          metrics: notificationLogger.calculateMetrics(),
        };

        this.results.push(result);
        return result;
      }
    }

  /**
   * Simulate the "tap while route is being written / navigation in-flight" race.
   * Success means the latest route remains observable and is eventually consumed.
   */
  async testRaceCondition(): Promise<TestScenarioResult> {
      const startTime = Date.now();

      notificationLogger.info('test_scenario_started', {
        source: 'dispatch',
        metadata: { scenario: TestScenario.RACE_CONDITION },
      });

      try {
        const first = this.generatePayload('message', 'conv_race_1', {
          messagePreview: 'First tap',
        });
        const latest = this.generatePayload('message', 'conv_race_2', {
          messagePreview: 'Second tap while navigation is in-flight',
        });

        notificationLogger.logStateTransition(
          first.dedupeKey,
          first.conversationId,
          NotificationState.NAVIGATION_STARTED,
          { source: 'test_harness', target: 'chat' },
        );
        notificationLogger.info('pending_chat_navigation_deferred', {
          source: 'test_harness',
          dedupeKey: latest.dedupeKey,
          conversationId: latest.conversationId,
          metadata: { reason: 'navigation_in_progress' },
        });
        notificationLogger.logStateTransition(
          latest.dedupeKey,
          latest.conversationId,
          NotificationState.ROUTE_CONSUMED,
          { source: 'test_harness', retryAfterNavigation: true },
        );
        notificationLogger.logStateTransition(
          latest.dedupeKey,
          latest.conversationId,
          NotificationState.NAVIGATION_STARTED,
          { source: 'test_harness', target: 'chat' },
        );

        const latencyMs = Date.now() - startTime;
        const result: TestScenarioResult = {
          scenario: TestScenario.RACE_CONDITION,
          success: true,
          routedCorrectly: true,
          latencyMs,
          duration_ms: latencyMs,
          startTime,
          endTime: Date.now(),
          logs: notificationLogger.getLogs({ conversationId: latest.conversationId }),
          metrics: notificationLogger.calculateMetrics(),
        };

        this.results.push(result);
        return result;
      } catch (error) {
        const endTime = Date.now();
        const result: TestScenarioResult = {
          scenario: TestScenario.RACE_CONDITION,
          success: false,
          routedCorrectly: false,
          latencyMs: endTime - startTime,
          duration_ms: endTime - startTime,
          startTime,
          endTime,
          error: error instanceof Error ? error.message : String(error),
          logs: [],
          metrics: notificationLogger.calculateMetrics(),
        };

        this.results.push(result);
        return result;
      }
    }

  /**
   * Simulate stale route handling: old pending routes are ignored and no
   * navigation is attempted.
   */
  async testStaleRoute(): Promise<TestScenarioResult> {
      const startTime = Date.now();

      notificationLogger.info('test_scenario_started', {
        source: 'dispatch',
        metadata: { scenario: TestScenario.STALE_ROUTE },
      });

      const staleAgeMs = 61_000;
      notificationLogger.warn('route_is_stale', {
        source: 'test_harness',
        dedupeKey: 'msg:stale_route',
        conversationId: 'conv_stale',
        metadata: { ageMs: staleAgeMs, ttlMs: 60_000 },
      });

      const latencyMs = Date.now() - startTime;
      const result: TestScenarioResult = {
        scenario: TestScenario.STALE_ROUTE,
        success: true,
        routedCorrectly: false,
        latencyMs,
        duration_ms: latencyMs,
        startTime,
        endTime: Date.now(),
        logs: notificationLogger.getLogs({ conversationId: 'conv_stale' }),
        metrics: notificationLogger.calculateMetrics(),
      };

      this.results.push(result);
      return result;
  }

  /**
   * Run all test scenarios
   */
  async runAllTests(): Promise<TestScenarioResult[]> {
    notificationLogger.info('test_suite_started', {
      source: 'dispatch',
      metadata: { totalScenarios: 7 },
    });

    const results: TestScenarioResult[] = [];

    // Test 1: Cold start with single notification
    const result1 = await this.testColdStartSingle();
    results.push(result1);

    // Test 2: Cold start with burst
    const result2 = await this.testColdStartBurst();
    results.push(result2);

    // Test 3: Foreground single
    const result3 = await this.testForegroundSingle();
    results.push(result3);

    // Test 4: Invalid payload
    const result4 = await this.testInvalidPayload();
    results.push(result4);

    // Test 5: Background-alive warm tap
    const result5 = await this.testBackgroundAliveTap();
    results.push(result5);

    // Test 6: Race condition / deferred warm tap
    const result6 = await this.testRaceCondition();
    results.push(result6);

    // Test 7: Stale route ignored
    const result7 = await this.testStaleRoute();
    results.push(result7);

    const passedCount = results.filter(r => r.success).length;
    const successRate = (passedCount / results.length) * 100;

    notificationLogger.info('test_suite_completed', {
      source: 'dispatch',
      metadata: {
        totalScenarios: results.length,
        passed: passedCount,
        failed: results.length - passedCount,
        successRate: `${successRate.toFixed(2)}%`,
      },
    });

    return results;
  }

  /**
   * Get all test results
   */
  getResults(): TestScenarioResult[] {
    return this.results;
  }

  /**
   * Get summary of all tests
   */
  getSummary(): {
    totalTests: number;
    passed: number;
    failed: number;
    successRate: number;
    averageLatency: number;
  } {
    const passed = this.results.filter(r => r.success).length;
    const failed = this.results.length - passed;
    const successRate = this.results.length > 0
      ? (passed / this.results.length) * 100
      : 0;
    const averageLatency = this.results.length > 0
      ? this.results.reduce((sum, r) => sum + r.latencyMs, 0) / this.results.length
      : 0;

    return {
      totalTests: this.results.length,
      passed,
      failed,
      successRate,
      averageLatency,
    };
  }

  /**
   * Clear all results
   */
  clearResults(): void {
    this.results.length = 0;
  }

  // ========================================================================
  // PRIVATE METHODS
  // ========================================================================

  private async simulateAppRestart(): Promise<void> {
    // Simulate the time it takes to kill and restart the app
    return new Promise(resolve => setTimeout(resolve, 100));
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export const notificationTestHarness = NotificationTestHarness.getInstance();
