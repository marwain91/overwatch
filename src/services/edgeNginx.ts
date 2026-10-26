import { EdgeConfigSchema, type EdgeConfig, type EdgeAccessRule } from '../models/edge';

export const EDGE_MANAGED_MARKER = '# Managed by Overwatch: edge v1';
// Nginx's config lexer needs doubled backslashes inside quoted regex tokens.
const quote = (value: string) => JSON.stringify(value);

function matchVariables(id: string, rule: Pick<EdgeAccessRule, 'path_regex' | 'source_ranges' | 'methods'>): string[] {
  const out: string[] = [];
  out.push(`geo $${id}_ip {`, `    default ${rule.source_ranges ? 0 : 1};`);
  for(const range of rule.source_ranges ?? []) out.push(`    ${range} 1;`);
  out.push('}', `map $uri $${id}_path {`, `    default ${rule.path_regex === undefined ? 1 : 0};`);
  if(rule.path_regex !== undefined) out.push(`    ${quote('~' + rule.path_regex)} 1;`);
  out.push('}', `map $request_method $${id}_method {`, `    default ${rule.methods ? 0 : 1};`);
  for(const method of rule.methods ?? []) out.push(`    ${method} 1;`);
  out.push('}', `map "$${id}_ip:$${id}_path:$${id}_method" $${id}_match {`, '    default 0;', '    "1:1:1" 1;', '}');
  return out;
}

/** Full http-context include. Client IP is the TCP peer; forwarded client headers are never trusted here. */
export function renderEdgeNginx(input: EdgeConfig): string {
  const edge = EdgeConfigSchema.parse(input);
  if(!edge.enabled) throw new Error('edge.enabled must be true');
  const out = [EDGE_MANAGED_MARKER,
    '# Generated from overwatch.yaml.edge; edit configuration, not this file.',
    'server_tokens off;', 'proxy_hide_header X-Powered-By;',
    'ssl_protocols TLSv1.2 TLSv1.3;', 'ssl_session_tickets off;',
    'client_header_timeout 15s;', 'client_body_timeout 60s;', 'send_timeout 60s;',
    // No query strings, Referer, credentials, request bodies or untrusted forwarding headers.
    `log_format overwatch_edge escape=json '{"time":"$time_iso8601","host":"$host","client":"$remote_addr","method":"$request_method","path":"$uri","status":$status,"bytes":$body_bytes_sent,"duration":$request_time}';`,
    'map $http_upgrade $ow_edge_connection { default upgrade; "" close; }',
    'server {', '    listen 80 default_server;', '    server_name _;', `    access_log ${quote(edge.access_log)} overwatch_edge;`, '    return 444;', '}',
    'server {', '    listen 443 ssl default_server;', '    server_name _;', '    ssl_reject_handshake on;', `    access_log ${quote(edge.access_log)} overwatch_edge;`, '    return 444;', '}',
  ];
  for(const site of edge.sites) {
    const prefix = `ow_edge_${site.name}`;
    for(const [i, rule] of site.access_control.rules.entries()) out.push(...matchVariables(`${prefix}_r${i}`, rule));
    const keys = site.access_control.rules.map((_,i)=>`$${prefix}_r${i}_match`).join(':');
    // Nginx map regexes are evaluated in order, preserving first-match policy semantics.
    out.push(`map "${keys}" $${prefix}_denied {`, `    default ${site.access_control.default_action === 'allow' ? 0 : 1};`);
    for(const [i,rule] of site.access_control.rules.entries()) out.push(`    ${quote(`~^(?:[01]:){${i}}1(?::|$)`)} ${rule.action === 'allow' ? 0 : 1};`);
    out.push('}');
    for(const limit of site.request_limits) {
      const id=`${prefix}_limit_${limit.name}`;
      out.push(...matchVariables(id,{path_regex:limit.path_regex,methods:limit.methods}));
      out.push(`geo $${id}_exempt {`, '    default 0;');
      for(const range of limit.exempt_ranges ?? []) out.push(`    ${range} 1;`);
      out.push('}',`map "$${id}_match:$${id}_exempt" $${id}_key {`, '    default "";', '    "1:0" $binary_remote_addr;', '}',`limit_req_zone $${id}_key zone=${id}:1m rate=${limit.requests_per_second}r/s;`);
    }
    out.push('server {', '    listen 80;', `    server_name ${site.host};`, `    access_log ${quote(edge.access_log)} overwatch_edge;`, `    return 301 https://${site.host}$request_uri;`, '}',
      'server {', '    listen 443 ssl;', '    http2 on;', `    server_name ${site.host};`,
      `    ssl_certificate ${quote(edge.tls.certificate)};`, `    ssl_certificate_key ${quote(edge.tls.certificate_key)};`,
      '    ssl_session_cache shared:OW_EDGE_SSL:10m;', '    ssl_session_timeout 10m;',
      '    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;',
      `    access_log ${quote(edge.access_log)} overwatch_edge;`,
      `    client_max_body_size ${site.max_body_size_mb}m;`, `    if ($${prefix}_denied) { return 403; }`,
      '    limit_req_status 429;', '    limit_req_log_level notice;');
    for(const limit of site.request_limits) out.push(`    limit_req zone=${prefix}_limit_${limit.name} burst=${limit.burst} nodelay;`);
    out.push('    location / {', `        proxy_pass ${edge.upstream};`, '        proxy_http_version 1.1;',
      '        proxy_set_header Host $host;', '        proxy_set_header X-Real-IP $remote_addr;',
      '        proxy_set_header X-Forwarded-For $remote_addr;', '        proxy_set_header X-Forwarded-Proto https;',
      '        proxy_set_header X-Forwarded-Host $host;', '        proxy_set_header Forwarded "";',
      '        proxy_set_header Upgrade $http_upgrade;', '        proxy_set_header Connection $ow_edge_connection;',
      `        proxy_read_timeout ${site.proxy_read_timeout_seconds}s;`, '    }', '}');
  }
  return out.join('\n')+'\n';
}
