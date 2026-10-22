import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { GATEWAY_NODE_FLAGS } from 'stg-core';
import { GATEWAY_ENTRY, checkGatewayPlist, parsePlist, renderGatewayPlist, renderMcpJson } from './service.js';

const HOME = path.join(os.tmpdir(), 'stg-plist-home');

describe('установка: плист службы (5.3) и .mcp.json (5.12)', () => {
  it('шаблон → плист → разбор: ProgramArguments с флагами памяти, KeepAlive, ThrottleInterval, ProcessType, журнал', () => {
    const xml = renderGatewayPlist({ bot: 'b_ot', home: HOME, node: '/opt/homebrew/bin/node' });
    const v = parsePlist(xml) as Record<string, unknown>;
    assert.equal(v.Label, 'local.smart-telegram-gateway.b_ot');
    assert.deepEqual(v.ProgramArguments, ['/opt/homebrew/bin/node', ...GATEWAY_NODE_FLAGS, GATEWAY_ENTRY]);
    assert.equal(v.KeepAlive, true);
    assert.equal(v.RunAtLoad, true);
    assert.equal(v.ThrottleInterval, 10);
    assert.equal(v.ProcessType, 'Interactive');
    assert.equal(v.StandardOutPath, path.join(HOME, 'logs', 'launchd.log'));
    assert.deepEqual(v.EnvironmentVariables, { STG_HOME: HOME });
  });

  it('экранирование: «&», «<», кавычки — туда и обратно без потерь', () => {
    const odd = '/tmp/a & b <c> "d"';
    const v = parsePlist(renderGatewayPlist({ bot: 'x', home: odd, node: '/n&ode' })) as Record<string, unknown>;
    assert.deepEqual(v.EnvironmentVariables, { STG_HOME: path.resolve(odd) });
    assert.equal((v.ProgramArguments as string[])[0], '/n&ode');
  });

  it('проверка doctor: годный · без флагов · без KeepAlive · чужой STG_HOME · не плист', () => {
    const good = renderGatewayPlist({ bot: 'x', home: HOME, node: process.execPath });
    const ok = checkGatewayPlist(good, HOME);
    // stg-gateway собран не всегда, когда идут модульные тесты; остальное — годно.
    if (fs.existsSync(GATEWAY_ENTRY)) assert.ok(ok.ok, ok.detail);
    assert.equal(ok.node, process.execPath);
    const noFlags = good.replace(/\t\t<string>--max-old-space-size=128<\/string>\n/, '');
    assert.match(checkGatewayPlist(noFlags, HOME).detail, /нет флагов памяти: --max-old-space-size=128/);
    assert.match(checkGatewayPlist(good.replace('<key>KeepAlive</key>\n\t<true/>', '<key>KeepAlive</key>\n\t<false/>'), HOME).detail, /нет KeepAlive/);
    assert.match(checkGatewayPlist(good, '/elsewhere').detail, /STG_HOME в плисте/);
    assert.equal(checkGatewayPlist('<plist version="1.0"><dict><key>Label</key></dict></plist>', HOME).ok, false);
    assert.equal(checkGatewayPlist('мусор', HOME).ok, false);
  });

  it('.mcp.json: ключ ровно smart-telegram-gateway; подстановки; лишний сервер — отказ', () => {
    const tpl = JSON.stringify({ mcpServers: { 'smart-telegram-gateway': { command: '{{NODE}}', args: ['{{CHANNEL_ENTRY}}'], env: { STG_HOME: '{{STG_HOME}}' } } } });
    const out = JSON.parse(renderMcpJson({ node: '/n', channelEntry: '/c.js', home: '/h' }, tpl)) as { mcpServers: Record<string, unknown> };
    assert.deepEqual(out.mcpServers, { 'smart-telegram-gateway': { command: '/n', args: ['/c.js'], env: { STG_HOME: '/h' } } });
    assert.throws(() => renderMcpJson({ node: '/n', home: '/h' }, JSON.stringify({ mcpServers: { other: {} } })), /ровно «smart-telegram-gateway»/);
    assert.throws(() => renderMcpJson({ node: '/n', home: '/h' }, JSON.stringify({ mcpServers: { 'smart-telegram-gateway': { command: '{{WHAT}}' } } })), /неизвестная подстановка/);
  });
});
