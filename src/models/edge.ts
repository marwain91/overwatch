import { z } from 'zod';
import { AccessRuleSchema } from './accessControl';

const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const filePath = z.string().regex(/^\/[a-zA-Z0-9_./-]+$/).refine(p => !p.split('/').includes('..'), 'No parent directory segments');
const host = z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
const methods = z.array(z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])).min(1).max(7);
// Reuse the validated regex/CIDR fields. Strict objects reject misspelled security settings.
const fields = AccessRuleSchema.shape;
export const EdgeAccessRuleSchema = z.strictObject({
  action: fields.action,
  description: fields.description,
  path_regex: fields.path_regex,
  source_ranges: fields.source_ranges,
  methods: methods.optional(),
}).refine(r => r.path_regex !== undefined || r.source_ranges !== undefined || r.methods !== undefined, 'A rule needs a path, source range or method');
export const EdgeSiteSchema = z.strictObject({
  name: identifier,
  host,
  access_control: z.strictObject({
    default_action: z.enum(['allow', 'deny']),
    rules: z.array(EdgeAccessRuleSchema).max(50),
  }),
  request_limits: z.array(z.strictObject({
    name: identifier,
    path_regex: fields.path_regex.unwrap(),
    methods: methods.optional(),
    requests_per_second: z.number().int().min(1).max(10000),
    burst: z.number().int().min(1).max(10000).default(20),
    exempt_ranges: fields.source_ranges,
  })).max(10).default([]),
  max_body_size_mb: z.number().int().min(1).max(1024).default(100),
  proxy_read_timeout_seconds: z.number().int().min(30).max(3600).default(300),
}).superRefine((site, ctx) => {
  if (new Set(site.request_limits.map(l => l.name)).size !== site.request_limits.length) ctx.addIssue({code:'custom',message:'Request limit names must be unique'});
});
export const EdgeConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  upstream: z.string().regex(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/).refine(v => Number(v.split(':').slice(-1)[0]) <= 65535).default('http://127.0.0.1:8080'),
  tls: z.strictObject({ certificate: filePath, certificate_key: filePath }),
  access_log: filePath.default('/var/log/nginx/overwatch-edge-access.log'),
  // Explicit adoption avoids deleting unrelated virtual hosts during initial installation.
  adopt_files: z.array(z.string().regex(/^[a-zA-Z0-9_-]+\.conf$/)).max(50).default([]),
  sites: z.array(EdgeSiteSchema).min(1).max(30),
}).superRefine((edge, ctx) => {
  for (const key of ['name','host'] as const) if (new Set(edge.sites.map(s=>s[key])).size !== edge.sites.length) ctx.addIssue({code:'custom',message:`Site ${key}s must be unique`});
  if(edge.adopt_files.includes('overwatch-edge.conf')) ctx.addIssue({code:'custom',message:'overwatch-edge.conf is managed automatically; do not adopt it'});
});
export type EdgeConfig = z.infer<typeof EdgeConfigSchema>;
export type EdgeAccessRule = z.infer<typeof EdgeAccessRuleSchema>;
