export interface NotificationChannel {
  id: string;
  name: string;
  type: 'webhook';
  enabled: boolean;
  config: WebhookConfig;
}

export interface WebhookConfig {
  url: string;
  headers?: Record<string, string>;
  method?: string;
}

export interface AlertHistoryEntry {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: string;
  message: string;
  tenantId?: string;
  containerName?: string;
  firedAt: string;
  resolvedAt?: string;
}
