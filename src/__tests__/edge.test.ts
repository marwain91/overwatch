import { describe, it, expect } from 'vitest';
import { EdgeConfigSchema } from '../models/edge';
import { renderEdgeNginx } from '../services/edgeNginx';

const base = () => ({enabled:true,tls:{certificate:'/cert/test.crt',certificate_key:'/cert/test.key'},sites:[{name:'product',host:'product.example.com',access_control:{default_action:'deny',rules:[{action:'allow',source_ranges:['10.0.0.0/8']},{action:'allow',path_regex:'^/portal(/|$)',methods:['GET','HEAD']}]}}]});
describe('managed edge schema',()=>{
  it('is opt-in and has bounded operational defaults',()=>{
    const raw=base();delete (raw as any).enabled;
    const parsed=EdgeConfigSchema.parse(raw);expect(parsed.enabled).toBe(false);expect(parsed.sites[0].max_body_size_mb).toBe(100);
    expect(()=>renderEdgeNginx(parsed)).toThrow('enabled');
  });
  it.each([
    {unexpected:true}, {adopt_files:['../product.conf']}, {adopt_files:['overwatch-edge.conf']},
    {upstream:'http://0.0.0.0:8080'}, {upstream:'http://127.0.0.1:65536'},
    {tls:{certificate:'/cert/a;include /evil',certificate_key:'/cert/key'}},
  ])('rejects unsafe or unknown edge settings %j',patch=>expect(EdgeConfigSchema.safeParse({...base(),...patch}).success).toBe(false));
  it.each([
    {name:'bad;return 200'}, {host:'example.com;'}, {host:'*.example.com'},
    {access_control:{default_action:'deny',rules:[{action:'allow',source_range:['10.0.0.0/8']}] }},
    {access_control:{default_action:'deny',rules:[{action:'allow',source_ranges:['10.0.0.0/33']}] }},
    {access_control:{default_action:'deny',rules:[{action:'allow',path_regex:'^/x\ninclude /evil;'}]}},
    {access_control:{default_action:'deny',rules:[{action:'allow',path_regex:'(?=x)'}]}},
    {access_control:{default_action:'deny',rules:[{action:'allow'}]}},
    {request_limits:[{name:'login',path_regex:'^/api/login$',requests_per_second:0}]},
  ])('rejects unsafe or misspelled site settings %j',patch=>{
    const raw=base();Object.assign(raw.sites[0],patch);expect(EdgeConfigSchema.safeParse(raw).success).toBe(false);
  });
  it('rejects duplicate hosts and names',()=>{
    const raw=base();raw.sites.push(raw.sites[0]);expect(EdgeConfigSchema.safeParse(raw).success).toBe(false);
  });
});
describe('managed edge renderer',()=>{
  it('uses peer IP, ordered rules, normalized paths and independent method checks',()=>{
    const out=renderEdgeNginx(EdgeConfigSchema.parse(base()));
    expect(out).toContain('geo $ow_edge_product_r0_ip');
    expect(out).toContain('map $uri $ow_edge_product_r1_path');
    expect(out).toContain('map $request_method $ow_edge_product_r1_method');
    expect(out.indexOf('~^(?:[01]:){0}1')).toBeLessThan(out.indexOf('~^(?:[01]:){1}1'));
    expect(out).toContain('proxy_set_header X-Forwarded-For $remote_addr;');
    expect(out).toContain('proxy_set_header Forwarded "";');
    expect(out).not.toContain('$proxy_add_x_forwarded_for');
  });
  it('rejects unknown hosts and hides versions without imposing app-specific CSP',()=>{
    const out=renderEdgeNginx(EdgeConfigSchema.parse(base()));
    expect(out).toContain('ssl_reject_handshake on;');expect(out).toContain('return 444;');
    expect(out).toContain('server_tokens off;');expect(out).toContain('proxy_hide_header X-Powered-By;');
    expect(out).toContain('ssl_protocols TLSv1.2 TLSv1.3;');
    expect(out).not.toContain('Content-Security-Policy');
  });
  it('never writes query strings, referers or raw request headers into managed access logs',()=>{
    const out=renderEdgeNginx(EdgeConfigSchema.parse(base()));
    const log=out.split('\n').find(l=>l.startsWith('log_format'))!;
    expect(log).toContain('$host');expect(log).toContain('$uri');
    for(const token of ['$request"','$request_uri','$args','$http_referer','$http_authorization'])expect(log).not.toContain(token);
  });
  it('builds endpoint-specific limit keys with explicit exemptions and 429 responses',()=>{
    const raw=base() as any;raw.sites[0].request_limits=[{name:'login',path_regex:'^/api/auth/login/?$',methods:['POST'],requests_per_second:2,burst:10,exempt_ranges:['10.0.0.0/8']}];
    const out=renderEdgeNginx(EdgeConfigSchema.parse(raw));
    expect(out).toContain('default "";');expect(out).toContain('"1:0" $binary_remote_addr;');
    expect(out).toContain('rate=2r/s;');expect(out).toContain('burst=10 nodelay;');expect(out).toContain('limit_req_status 429;');
    expect(out).not.toContain('limit_conn');
  });
});
