// 链路诊断：按指定 MAC 顺序连接两个手环，开 preview 一段时间，
// 每 5 秒打印每个槽位的帧数/丢帧/丢包率/MTU/RSSI。
//
// 用法:
//   node tools/ble_link_diag.js --slot1 <MAC1> --slot2 <MAC2> --seconds 60 [--order 2,1]
//   （只给一个槽位即单设备测试）
const WebSocket = require('ws');

function parseArgs(argv) {
    const out = { seconds: 60 };
    for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i].replace(/^--/, '');
        out[key] = argv[i + 1];
    }
    return out;
}

const args = parseArgs(process.argv.slice(2));
let seq = 0;

function makeClient(url) {
    const ws = new WebSocket(url);
    const pending = new Map();
    ws.on('message', raw => {
        let msg;
        try { msg = JSON.parse(raw.toString('utf8')); } catch (_) { return; }
        if (msg.type === 'response' && msg.request_id && pending.has(msg.request_id)
            && (typeof msg.success === 'boolean' || msg.action === 'status')) {
            const { resolve } = pending.get(msg.request_id);
            pending.delete(msg.request_id);
            resolve(msg);
        }
    });
    const ready = new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    const call = (action, extra = {}, timeoutMs = 30000) => new Promise((resolve, reject) => {
        const requestId = `diag_${++seq}`;
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${action} timeout`)); }, timeoutMs);
        pending.set(requestId, { resolve: m => { clearTimeout(timer); resolve(m); } });
        ws.send(JSON.stringify({ action, request_id: requestId, ...extra }));
    });
    return { ws, ready, call };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    const ctl = makeClient('ws://localhost:8764');
    await ctl.ready;

    const slots = [];
    if (args.scan === '1' || args.scan === 'true') {
        const scanReply = await ctl.call('scan', {}, 40000);
        console.log('scan:', scanReply.success, 'devices=', (scanReply.devices || []).length);
    }
    const order = (args.order || '1,2').split(',').map(Number).filter(slot => slot === 1 || slot === 2);
    for (const slot of order) {
        const mac = slot === 1 ? args.slot1 : args.slot2;
        if (!mac) continue;
        const reply = await ctl.call(`connect${slot}`, { mac }, 40000);
        console.log(`connect${slot} ${mac}: success=${reply.success} name=${reply.name || '-'} mtu=${reply.mtu ?? '?'} rssi=${reply.rssi ?? '?'}`);
        if (!reply.success) throw new Error(`connect${slot} 失败: ${reply.error || 'unknown'}`);
        slots.push(slot);
    }
    if (!slots.length) throw new Error('至少给一个 --slot1/--slot2 MAC');

    await ctl.call('set_session_id', { session_id: `DIAG${Date.now() % 100000}` }, 8000);
    const preview = await ctl.call('start_preview_stream', {}, 30000);
    console.log('preview:', preview.success, JSON.stringify(preview.started));

    const switching = args.switch === '1' || args.switch === 'true';
    if (switching) {
        await sleep(10000);
        const sw = await ctl.call('switch_preview_to_collection', { expected_devices: slots }, 90000);
        console.log('switch:', sw.success, JSON.stringify(sw.bins || {}), sw.error || '');
    }

    const seconds = Number(args.seconds) || 60;
    const startedAt = Date.now();
    while (Date.now() - startedAt < seconds * 1000) {
        await sleep(5000);
        const st = await ctl.call('status', {}, 8000);
        const line = slots.map(slot => {
            const d = st[`dev${slot}`] || {};
            const total = d.total || 0;
            const lost = d.lost || 0;
            const rate = total + lost > 0 ? (100 * lost / (total + lost)).toFixed(1) : '0.0';
            return `dev${slot} ${d.name || '-'} total=${total} lost=${lost} (${rate}%) mtu=${d.mtu ?? '?'} rssi=${d.rssi ?? '?'}`;
        }).join(' | ');
        console.log(`t=${Math.round((Date.now() - startedAt) / 1000)}s  ${line}`);
    }

    await ctl.call(switching ? 'stop_collection_stream' : 'stop_preview_stream', {}, 15000).catch(() => {});
    for (const slot of slots) {
        await ctl.call(`disconnect${slot}`, {}, 15000).catch(() => {});
    }
    ctl.ws.close();
    setTimeout(() => process.exit(0), 500);
})().catch(error => {
    console.error('诊断失败:', error.message);
    process.exit(1);
});
