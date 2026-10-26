import { isIP } from 'node:net';
import { RE2JS } from 're2js';
import { z } from 'zod';

function isIpRange(value: string): boolean {
  const [address, prefix, extra] = value.split('/');
  const family = isIP(address);
  if (!family || address.includes('%') || extra !== undefined) return false;
  return prefix === undefined || (/^(0|[1-9][0-9]*)$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128));
}

const PathRegexSchema = z.string().min(1).max(1024).superRefine((value, ctx) => {
  if (/[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Path regex must be a single line without control characters' });
    return;
  }
  try {
    RE2JS.compile(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid Go/RE2 path regex (lookaround and backreferences are unsupported)' });
  }
});

// A typo such as source_range must never turn an IP-limited path into a public one.
export const AccessRuleSchema = z.strictObject({
  action: z.enum(['allow', 'deny']),
  description: z.string().max(200).optional(),
  path_regex: PathRegexSchema.optional().describe('Go/RE2 regex matched against the original request path, without the query string'),
  source_ranges: z.array(z.string().trim().refine(isIpRange, 'Expected an IPv4/IPv6 address or CIDR range')).min(1).max(100).optional()
    .describe('Match any of these client IPs or CIDRs; combined with path_regex using AND'),
}).superRefine((rule, ctx) => {
  if (rule.path_regex === undefined && rule.source_ranges === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A rule needs path_regex, source_ranges, or both; use default_action for the fallback' });
  }
});

export const AccessControlSchema = z.strictObject({
  default_action: z.enum(['allow', 'deny']).describe('Action when no rule matches'),
  rules: z.array(AccessRuleSchema).max(50).describe('First matching rule wins, in array order'),
});

export type AccessControl = z.infer<typeof AccessControlSchema>;
