/**
 * Local dashboard for the TikTok Ads plugin.
 *
 * IA: 左侧账户选择（全选 = 合并，多选 = 分开对比）→ 展示台 KPI/趋势图 → 广告组
 * → 下钻到 SKU/素材 → 点击任意对象查看「按天涨幅曲线」。
 *
 * Runs a small HTTP server on 127.0.0.1 inside the DSH host and serves one
 * self-contained page (no build step, no CDN, hand-rolled SVG charts).
 */
import fs from 'node:fs'
import http from 'node:http'
import { URL } from 'node:url'

const PAGE = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TikTok 广告监控台</title>
<style>
*{box-sizing:border-box}
:root{color-scheme:dark;--bg:#0b0d12;--bg2:#11141c;--panel:#151926;--panel2:#1b2030;--line:#242a3a;--line2:#2f3648;
--ink:#e9ecf3;--muted:#8f97a8;--accent:#4f7cff;--good:#2fbf87;--warn:#e7a33c;--bad:#ef4d5a;--chip:#1e2432}
body{margin:0;background:var(--bg);color:var(--ink);font:13.5px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.app{display:flex;min-height:100vh}
aside{width:236px;flex:0 0 236px;background:var(--bg2);border-right:1px solid var(--line);padding:18px 14px;position:sticky;top:0;height:100vh;overflow:auto}
.brand{display:flex;align-items:center;gap:9px;font-size:15px;font-weight:650;margin-bottom:18px}
.dot{width:9px;height:9px;border-radius:50%;background:var(--accent);box-shadow:0 0 10px var(--accent)}
h4{margin:18px 0 8px;font-size:11px;letter-spacing:.08em;color:var(--muted);text-transform:uppercase}
.acct{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;cursor:pointer;color:var(--ink)}
.acct:hover{background:var(--panel)}
.acct input{accent-color:var(--accent)}
.acct small{color:var(--muted);margin-left:auto;font-size:11px}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{padding:5px 10px;border-radius:999px;border:1px solid var(--line);background:var(--chip);color:var(--muted);cursor:pointer;font-size:12px}
.chip[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:#fff}
nav{display:flex;flex-direction:column;gap:4px;margin-top:18px}
nav button{text-align:left;padding:9px 11px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--muted);cursor:pointer;font:inherit}
nav button[aria-current=true]{background:var(--panel);border-color:var(--line2);color:var(--ink)}
main{flex:1;padding:18px 22px;max-width:1560px}
.head{display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap}
.head h2{font-size:16px;margin:0;font-weight:600}
.head .sub{color:var(--muted);font-size:12px}
.head .sp{flex:1}
button.act{padding:7px 13px;border-radius:8px;border:1px solid var(--line2);background:var(--panel2);color:var(--ink);cursor:pointer;font:inherit}
button.act:hover{border-color:var(--accent)}
button.act.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px}
.kpi{background:linear-gradient(180deg,var(--panel),#121622);border:1px solid var(--line);border-radius:12px;padding:13px 15px}
.kpi .k{color:var(--muted);font-size:11.5px}
.kpi .v{font-size:22px;font-weight:680;margin-top:3px;font-variant-numeric:tabular-nums}
.grid2{display:grid;grid-template-columns:1.55fr 1fr;gap:12px}
@media(max-width:1150px){.grid2{grid-template-columns:1fr}}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 15px;margin-bottom:12px}
.card h3{margin:0 0 10px;font-size:13px;font-weight:600;color:var(--ink);display:flex;align-items:center;gap:8px}
.card h3 .muted{color:var(--muted);font-weight:400;font-size:11.5px}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{padding:7px 9px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:360px}
th{color:var(--muted);font-weight:500;font-size:11.5px;position:sticky;top:0;background:var(--panel)}
tbody tr:hover{background:var(--panel2)}
tbody tr.click{cursor:pointer}
.num{text-align:right}
.good{color:var(--good)}.warn{color:var(--warn)}.bad{color:var(--bad)}
.empty{color:var(--muted);text-align:center;padding:22px 0;font-size:12.5px}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11.5px;border:1px solid var(--line2);background:var(--chip)}
.pill.critical{border-color:#5c2730;color:#ff9e9e;background:#2a1418}
.pill.warning{border-color:#5c4a24;color:#ffd694;background:#241f12}
.spark{width:96px;height:22px}
.charttip{position:fixed;z-index:80;display:none;pointer-events:none;background:rgba(11,14,20,.96);border:1px solid var(--line2);border-radius:9px;padding:7px 9px;font-size:11.5px;line-height:1.55;min-width:140px;box-shadow:0 8px 24px rgba(0,0,0,.45)}
.charttip .t{color:var(--muted);margin-bottom:3px}
.charttip .r{display:flex;align-items:center;gap:6px;color:var(--muted)}
.charttip .r i{width:8px;height:8px;border-radius:2px;display:inline-block}
.charttip .r b{margin-left:auto;color:var(--ink);font-variant-numeric:tabular-nums}
.charttip .r.sep{border-top:1px solid var(--line);margin-top:4px;padding-top:4px}
.modal{position:fixed;inset:0;background:rgba(4,6,10,.72);display:none;align-items:center;justify-content:center;padding:24px;z-index:50}
.modal[open]{display:flex}
.sheet{background:var(--bg2);border:1px solid var(--line2);border-radius:14px;width:min(980px,96vw);max-height:88vh;overflow:auto;padding:18px 20px}
.sheet h3{margin:0 0 4px;font-size:15px}
.sheet .meta{color:var(--muted);font-size:12px;margin-bottom:12px}
.close{float:right;background:transparent;border:1px solid var(--line2);color:var(--muted);border-radius:8px;padding:4px 10px;cursor:pointer}
.chartwrap{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px 6px 2px}
.legend{display:flex;gap:14px;flex-wrap:wrap;margin:6px 0 2px;color:var(--muted);font-size:11.5px}
.legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
footer{color:var(--muted);font-size:11.5px;margin-top:16px}
.loading{color:var(--muted);font-size:12px}
input{background:#0f1320;border:1px solid var(--line2);color:var(--ink);border-radius:8px;padding:6px 9px;font:inherit}
select{background:#0f1320;border:1px solid var(--line2);color:var(--ink);border-radius:8px;padding:6px 9px;font:inherit}
.aiLine{display:flex;gap:8px;padding:5px 0;border-bottom:1px dashed var(--line);font-size:12.5px}
.aiLine:last-child{border-bottom:0}
.aiLine .n{color:var(--muted);min-width:18px}
.aiTag{font-size:11px;padding:1px 7px;border-radius:6px;border:1px solid transparent;white-space:nowrap}
.aiTag.critical{background:#2a1418;border-color:#5c2730;color:#ff9e9e}
.aiTag.warning{background:#241f12;border-color:#5c4a24;color:#ffd694}
.aiTag.good{background:rgba(47,191,135,.15);border-color:rgba(47,191,135,.45);color:#8ce3bd}
.expFile{display:flex;align-items:center;gap:10px;font-size:12.5px;padding:4px 0}
.expFile .n{color:#9fb6ff;cursor:copy}
.warnCard{border-color:#5c4a24;background:#241f12}
.warnCard h3{color:#ffd694;margin-bottom:6px}
.horseGrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
@media(max-width:1250px){.horseGrid{grid-template-columns:1fr}}
.horse{background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:10px}
.horse h4{margin:0 0 8px;font-size:12px;display:flex;align-items:center;gap:6px;text-transform:none;letter-spacing:0}
.horse h4 span{color:var(--muted);font-weight:400;margin-left:auto;font-size:11.5px}
.horseRow{display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px dashed var(--line);font-size:11.5px}
.horseRow:last-child{border-bottom:0}
.horseRow .id{color:#9fb6ff;cursor:copy;font-variant-numeric:tabular-nums}
.horseRow .m{margin-left:auto;color:var(--muted);font-variant-numeric:tabular-nums}
.horseRow .act{padding:1px 7px;font-size:11px}
.diagTag{font-size:11px;padding:1px 7px;border-radius:6px;border:1px solid transparent}
.diagTag.kill{background:#2a1418;border-color:#5c2730;color:#ff9e9e}
.diagTag.fix{background:#241f12;border-color:#5c4a24;color:#ffd694}
.diagTag.scale{background:rgba(47,191,135,.15);border-color:rgba(47,191,135,.45);color:#8ce3bd}
.diagTag.watch,.diagTag.ok{background:var(--chip);border-color:var(--line2);color:var(--muted)}
.filterbar{position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:18px;flex-wrap:wrap;padding:9px 14px;margin:-4px 0 12px;background:rgba(17,20,28,.92);border:1px solid var(--line);border-radius:12px;backdrop-filter:blur(6px)}
.filterbar.faded{opacity:.45;pointer-events:none}
.tzClock{font-variant-numeric:tabular-nums;font-size:12px;color:#9fb6ff;background:rgba(79,124,255,.12);border:1px solid rgba(79,124,255,.35);border-radius:7px;padding:2px 8px;min-width:78px;text-align:center}
.bclock{margin-left:auto;font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}
.fbgroup{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.fblabel{color:var(--muted);font-size:11px;letter-spacing:.04em}
.fbDates{display:flex;align-items:center;gap:6px}
.fbDates input[type=date]{padding:4px 7px;font-size:12px}
.fbDates .act{padding:4px 10px;font-size:12px}
.fbHint{font-size:11.5px;margin-left:auto}
#accountList{gap:6px}
#accountList .acct{padding:4px 9px;border:1px solid var(--line);border-radius:999px;background:var(--chip);font-size:12px;color:var(--muted)}
#accountList .acct:has(input:checked){border-color:var(--accent);color:#fff;background:rgba(79,124,255,.16)}
#accountList .acct input{accent-color:var(--accent)}
#accountList .acct small{font-size:10.5px}
.board{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
@media(max-width:1180px){.board{grid-template-columns:minmax(0,1fr)}}
@media(max-width:1250px){.board{grid-template-columns:1fr}}
.bcard{padding:12px 14px}
.bhead{display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}
.badge{font-size:11px;padding:1px 7px;border-radius:6px;border:1px solid transparent;font-weight:600;letter-spacing:.02em}
.badge.kind-account{background:rgba(79,124,255,.16);border-color:rgba(79,124,255,.5);color:#9fb6ff}
.badge.kind-campaign{background:rgba(47,191,135,.15);border-color:rgba(47,191,135,.45);color:#8ce3bd}
.badge.kind-items{background:rgba(231,163,60,.15);border-color:rgba(231,163,60,.45);color:#ffd08a}
.bkpis span{cursor:pointer;padding:3px 9px;border-radius:9px;border:1px solid transparent;transition:background .12s,border-color .12s}
.bkpis span:hover{background:rgba(255,255,255,.04)}
.bkpis span.on{border-color:var(--line2);background:rgba(79,124,255,.10)}
.bkpis span i:before{content:'';display:inline-block;width:9px;height:9px;border:1px solid var(--line2);border-radius:3px;margin-right:5px;vertical-align:-1px}
.bkpis span.on i:before{content:'✓';color:#fff;background:var(--accent);border-color:var(--accent);font-size:8px;line-height:9px;text-align:center}
.btitle{font-weight:600;font-size:13px;max-width:62%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bhead .act{padding:3px 8px;font-size:11.5px}
.bkpis{display:flex;gap:18px;flex-wrap:wrap;margin-bottom:8px}
.bkpis span{display:flex;flex-direction:column;font-size:11.5px;color:var(--muted)}
.bkpis b{font-size:15px;color:var(--ink);font-variant-numeric:tabular-nums;margin-top:1px}
.blive{font-size:11.5px;color:var(--muted);margin:2px 0 0;font-variant-numeric:tabular-nums}
.expandedBox{margin-top:10px;border-top:1px solid var(--line);padding-top:8px}
#expandModal .sheet{max-height:92vh}
#expandBody .expandedTable{max-height:60vh}
.cardTz{margin-left:6px;padding:2px 6px;font-size:11px;border-radius:6px}
.bsplit{display:grid;grid-template-columns:1.55fr minmax(0,1fr);gap:14px;margin-top:8px;align-items:start}
@media(max-width:1100px){.bsplit{grid-template-columns:1fr}}
.bleft{min-width:0}
.bright{min-width:0;border-left:1px solid var(--line);padding-left:14px}
@media(max-width:1100px){.bright{border-left:0;padding-left:0}}
.brightHead{font-size:12px;color:var(--muted);margin-bottom:6px}
.cmpBar{display:flex;align-items:center;gap:8px;margin:8px 0 2px;font-size:11.5px;color:var(--muted);flex-wrap:wrap}
.cmpToggle{display:inline-flex;align-items:center;gap:5px;cursor:pointer;color:var(--ink)}
.cmpToggle input{width:13px;height:13px;accent-color:var(--accent);cursor:pointer}
.cmpDateText{font-variant-numeric:tabular-nums;color:#9fb6ff;background:rgba(79,124,255,.12);border:1px solid rgba(79,124,255,.35);border-radius:6px;padding:1px 7px}
.cmpEditor{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11.5px;color:var(--muted);margin:0 0 4px;padding:6px 8px;border:1px dashed var(--line2);border-radius:8px}
.cmpEditor input{padding:2px 6px;font-size:11.5px;border-radius:6px;background:var(--panel2);color:var(--ink);border:1px solid var(--line)}
.cmpSummary{display:flex;gap:14px;flex-wrap:wrap;font-size:11.5px;color:var(--muted);margin:4px 0 2px}
.cmpSummary b{color:var(--ink);font-weight:600}
.cmpUp{color:var(--good)}
.cmpDown{color:var(--bad)}
.cardItems{max-height:300px;overflow:auto;border:1px solid var(--line);border-radius:8px}
.cardItems table{margin:0;font-size:11.5px}
.cardItems thead th{position:sticky;top:0;background:var(--panel);z-index:2}
.cardItems td{padding:4px 7px}
.cardClockBig{font-variant-numeric:tabular-nums;font-size:16px;font-weight:600;color:#c7d6ff;margin-left:auto}
.expFile .dl{background:var(--accent);border:1px solid var(--accent);color:#fff;border-radius:7px;padding:3px 10px;font-size:11.5px;text-decoration:none}
.expandedTools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;font-size:11.5px;color:var(--muted)}
.expandedTable{max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:8px}
.expandedTable table{margin:0;font-size:11.5px}
.expandedTable thead th{position:sticky;top:0;background:var(--panel);z-index:2}
.expandedTable td{padding:5px 7px}
.st-kill{color:#ff9e9e;font-size:11px}
.st-watch{color:#ffd694;font-size:11px}
.st-scale{color:#8ce3bd;font-size:11px}
.st-normal{color:var(--muted);font-size:11px}
.favBtn{background:transparent;border:0;cursor:pointer;font-size:13px;color:#5b6478;padding:0 2px}
.favBtn.on{color:#f5c542}
.rowNote{background:transparent;border:1px solid transparent;border-radius:6px;padding:2px 5px;width:110px;font-size:11px;color:var(--ink)}
.rowNote:focus{background:#0f1320;border-color:var(--line2)}
.bItems{margin-top:8px;border-top:1px solid var(--line);padding-top:6px}
.bItem{display:flex;align-items:center;gap:10px;font-size:11.5px;padding:2px 0}
.bItem .link{font-variant-numeric:tabular-nums}
.pid{font-variant-numeric:tabular-nums;color:#9fb6ff;border-bottom:1px dashed rgba(159,182,255,.5);cursor:copy}
th.sortable{cursor:pointer;user-select:none}
th.sortable:hover{color:var(--ink)}
.drillTools{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px}
.scrollbox{max-height:min(56vh,620px);overflow:auto;border:1px solid var(--line);border-radius:10px}
.scrollbox table{margin:0}
.scrollbox thead th{position:sticky;top:0;z-index:2;background:var(--panel)}
#drillCard .grid2{grid-template-columns:0.85fr 1.5fr}
.skuSearch{width:200px}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid var(--line2);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite;vertical-align:-2px;margin-right:6px}
@keyframes spin{to{transform:rotate(360deg)}}
.loadingBox{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:12.5px;padding:16px 4px}
.drillTools .muted{font-size:11.5px}
.pid:hover{color:#c7d6ff}
.bItem .act{padding:1px 8px;font-size:11px}
.balerts{display:flex;flex-direction:column;gap:3px;margin:2px 0 8px}
.balerts .a{font-size:11.5px;padding:3px 8px;border-radius:7px;border:1px solid transparent}
.balerts .a.critical{background:#2a1418;border-color:#5c2730;color:#ff9e9e}
.balerts .a.warning{background:#241f12;border-color:#5c4a24;color:#ffd694}
.bcard.half{grid-column:span 1}
.brow{display:flex;align-items:center;gap:10px;margin-top:8px;flex-wrap:wrap}
.bnote{flex:1;min-width:200px;background:transparent;border-color:transparent;border-bottom:1px dashed var(--line2);border-radius:0;padding:3px 4px}
.bnote:focus{background:#0f1320;border:1px solid var(--line2);border-radius:8px}
.bnote::placeholder{color:#5d6577}
.bsig{font-size:11px;color:var(--muted);letter-spacing:.02em}
.dlg{position:fixed;inset:0;background:rgba(4,6,10,.75);display:none;align-items:center;justify-content:center;padding:20px;z-index:60}
.dlg[open]{display:flex}
.dlgbox{background:var(--bg2);border:1px solid var(--line2);border-radius:14px;width:min(860px,96vw);max-height:90vh;overflow:auto;padding:18px 20px}
.dlgbox h3{margin:0 0 12px;font-size:15px}
.field{display:flex;gap:10px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
.field label{color:var(--muted);font-size:12px;min-width:64px}
.itemlist{max-height:280px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:8px}
.srow{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--line);border-radius:9px;margin-bottom:6px;background:var(--panel)}
.srow .stext{flex:1;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.srow .act{padding:3px 10px;font-size:11.5px}
.itemrow{display:flex;align-items:center;gap:8px;padding:6px 6px;border-radius:7px;cursor:pointer;font-size:12.5px}
.itemrow:hover{background:var(--panel2)}
.itemrow input{accent-color:var(--accent)}
.itemrow .muted{margin-left:auto;font-size:11.5px}
.itemrow .itemid{font-variant-numeric:tabular-nums;font-size:12px}
.dlgfoot{display:flex;gap:10px;justify-content:flex-end;margin-top:14px;align-items:center}
</style></head><body>
<div class="app">
<aside>
  <div class="brand"><span class="dot"></span>TikTok 广告监控台</div>
  <nav>
    <button data-tab="watch" aria-current="true">盯盘</button>
    <button data-tab="campaigns" aria-current="false">广告组</button>
    <button data-tab="ai" aria-current="false">AI 监控投放</button>
    <button data-tab="export" aria-current="false">数据导出</button>
    <button data-tab="products" aria-current="false">商品信息</button>
    <button data-tab="diagnosis" aria-current="false">诊断 <span class="muted" style="font-size:10.5px">beta</span></button>
    <button data-tab="desk" aria-current="false" hidden>展示台</button>
    <button data-tab="alerts" aria-current="false" hidden>告警 <span id="alertBadge"></span></button>
    <button data-tab="settings" aria-current="false" hidden>设置</button>
  </nav>
</aside>
<main>
  <div class="head">
    <button class="act" id="btnBackWatch" style="display:none" title="返回盯盘">← 盯盘</button>
    <h2 id="pageTitle">展示台</h2>
    <span class="sub" id="pageSub"></span>
    <span class="sp"></span>
    <button class="act" id="btnAlerts" title="告警">告警 <span id="alertBadge2"></span></button>
    <button class="act" id="btnSettings" title="设置">⚙</button>
    <button class="act" id="btnRefresh">刷新</button>
    <button class="act primary" id="btnScan">立即扫描</button>
  </div>

  <div class="filterbar" id="filterBar">
    <div class="fbgroup" id="fbAccounts">
      <span class="fblabel">账户</span>
      <div id="accountList" class="chips"><div class="loadingBox"><span class="spinner"></span>加载账户…</div></div>
    </div>
    <div class="fbgroup" id="fbRange">
      <span class="fblabel">时间</span>
      <div class="chips" id="rangeChips">
        <button class="chip" data-mode="today" aria-pressed="false">今日</button>
        <button class="chip" data-days="1" aria-pressed="false">昨天</button>
        <button class="chip" data-days="3" aria-pressed="false">3 天</button>
        <button class="chip" data-days="7" aria-pressed="true">7 天</button>
        <button class="chip" data-days="14" aria-pressed="false">14 天</button>
        <button class="chip" data-days="30" aria-pressed="false">30 天</button>
        <button class="chip" data-mode="custom" aria-pressed="false">自定义</button>
      </div>
      <div id="customRange" hidden class="fbDates">
        <input type="date" id="rangeStart" title="开始日期">
        <span class="muted">→</span>
        <input type="date" id="rangeEnd" title="结束日期">
        <button class="act" id="applyRange">应用并刷新</button>
      </div>
    </div>
    <div class="fbgroup">
      <span class="fblabel">时区</span>
      <select id="tzSelect">
        <option value="account">跟随账户</option>
        <option value="UTC">UTC</option>
        <option value="Europe/London">英国 London</option>
        <option value="Europe/Berlin">德国/欧洲 Berlin</option>
        <option value="Europe/Paris">法国 Paris</option>
        <option value="Europe/Madrid">西班牙 Madrid</option>
        <option value="Europe/Rome">意大利 Rome</option>
        <option value="America/New_York">美东 New York</option>
        <option value="America/Chicago">美中 Chicago</option>
        <option value="America/Denver">美山 Denver</option>
        <option value="America/Los_Angeles">美西 Los Angeles</option>
        <option value="America/Sao_Paulo">巴西 São Paulo</option>
        <option value="America/Mexico_City">墨西哥 Mexico City</option>
        <option value="Asia/Dubai">中东 Dubai</option>
        <option value="Asia/Kolkata">印度 Kolkata</option>
        <option value="Asia/Jakarta">印尼 Jakarta</option>
        <option value="Asia/Singapore">新加坡 Singapore</option>
        <option value="Asia/Manila">菲律宾 Manila</option>
        <option value="Asia/Bangkok">泰国 Bangkok</option>
        <option value="Asia/Ho_Chi_Minh">越南 Ho Chi Minh</option>
        <option value="Asia/Shanghai">中国 Shanghai</option>
        <option value="Asia/Tokyo">日本 Tokyo</option>
        <option value="Asia/Seoul">韩国 Seoul</option>
        <option value="Australia/Sydney">澳洲 Sydney</option>
        <option value="Pacific/Auckland">新西兰 Auckland</option>
      </select>
      <span class="tzClock" id="tzClock">--:--:--</span>
    </div>
    <span class="fbHint muted" id="filterHint"></span>
  </div>

  <section id="tab-desk">
    <div class="kpis" id="kpis"></div>
    <div class="grid2">
      <div class="card">
        <h3>趋势 <span class="muted" id="chartHint">合并视图</span>
          <span class="chips" id="metricChips" style="margin-left:auto">
            <button class="chip" data-metric="cost" aria-pressed="true">消耗</button>
            <button class="chip" data-metric="revenue" aria-pressed="false">GMV</button>
            <button class="chip" data-metric="roi" aria-pressed="false">ROI</button>
            <button class="chip" data-metric="orders" aria-pressed="false">订单</button>
          </span>
        </h3>
        <div class="chartwrap"><div id="mainChart"></div></div>
        <div class="legend" id="mainLegend"></div>
      </div>
      <div class="card"><h3>广告账户</h3><div id="accountTable"></div></div>
    </div>
  </section>

  <section id="tab-watch" hidden>
    <div class="card">
      <h3>盯盘看板 <span class="muted" id="boardSummary">模块化：每个模块盯一个对象（账户 / 广告组 / 多条素材），60 秒自动刷新</span>
        <span class="sp" style="flex:1"></span>
        <span class="chips" id="boardInterval" title="自动刷新间隔">
          <button class="chip" data-interval="15">15s</button>
          <button class="chip" data-interval="30">30s</button>
          <button class="chip" data-interval="60" aria-pressed="true">60s</button>
        </span>
        <span class="muted" id="boardLive" style="font-size:11.5px"></span>
        <button class="act" id="btnExportBoard" title="把当前看板数据导出为 CSV">导出 CSV</button>
        <button class="act primary" id="btnAddModule">+ 添加盯盘模块</button>
        <button class="act" id="btnRefreshBoard">刷新</button>
      </h3>
      <div class="muted" id="boardHint" style="font-size:12px">还没有模块，点右上角「+ 添加盯盘模块」开始。<span id="boardStatus"></span></div>
    </div>
    <div id="boardGrid" class="board"></div>
  </section>

  <section id="tab-products" hidden>
    <div class="card">
      <h3>导入商品信息 <span class="muted">卖家中心导出的商品表，用来和广告数据合并</span></h3>
      <div class="muted" style="font-size:12px;line-height:1.7;margin-bottom:8px">
        <b>怎么导出：</b>打开
        <a class="link" href="https://seller.eu.tiktokshopglobalselling.com/product/batch/edit-prods?entry-from=manage&shop_region=GB" target="_blank" rel="noopener">卖家中心 › 商品 › 批量编辑 / 全部信息</a>
        → 选择店铺 → 点「导出」→ 下载到的 xlsx 直接拖到这里（含 product_id / 商家 SKU / 商品名称 / 价格 / 状态）
      </div>
      <div class="tools">
        <label>店铺区域
          <select id="prodRegion">
            <option value="GB">GB（英国）</option>
            <option value="DE">DE（德国）</option>
            <option value="FR">FR（法国）</option>
            <option value="IT">IT（意大利）</option>
            <option value="ES">ES（西班牙）</option>
          </select>
        </label>
        <input type="file" id="prodFile" accept=".xlsx,.csv">
        <button class="act primary" id="prodUpload">导入</button>
        <button class="act" id="prodGuide">复制导入指引</button>
        <span class="muted" id="prodStatus"></span>
      </div>
      <div class="muted" id="prodMeta" style="font-size:12px;margin-top:6px"></div>
    </div>
    <div class="card">
      <h3>商品 × 广告 <span class="muted" id="prodJoinHint"></span>
        <span class="sp" style="flex:1"></span>
        <input id="prodSearch" placeholder="搜索 SKU / 商品名" style="width:200px">
      </h3>
      <div id="prodTable" class="scrollbox"></div>
    </div>
  </section>

  <section id="tab-ai" hidden>
    <div class="kpis" id="aiKpis"></div>
    <div class="card">
      <h3>巡检结论 <span class="muted" id="aiRange"></span>
        <span class="sp" style="flex:1"></span>
        <button class="act" id="aiCopy">复制巡检摘要</button>
      </h3>
      <div id="aiConclusions"></div>
    </div>
    <div class="card">
      <h3>建议动作</h3>
      <div id="aiActions"></div>
    </div>
    <div class="card">
      <h3>盯盘告警</h3>
      <div id="aiAlerts"></div>
    </div>
  </section>

  <section id="tab-export" hidden>
    <div class="card">
      <h3>数据导出 <span class="muted">格式与桌面「每日广告订单」一致（每天一个 xlsx：商品明细 / 素材明细 / SKU销量 / 说明）</span></h3>
      <div class="tools">
        <label>开始 <input type="date" id="expStart"></label>
        <label>结束 <input type="date" id="expEnd"></label>
        <button class="act primary" id="expRun">开始导出</button>
        <span class="muted" id="expStatus"></span>
      </div>
      <div class="muted" style="font-size:12px;margin-top:6px">导出目录：桌面\广告\每日广告订单（已存在的日期会覆盖）</div>
      <div id="expResult" style="margin-top:10px"></div>
    </div>
  </section>

  <section id="tab-diagnosis" hidden>
    <div class="card warnCard">
      <h3>⚠ 待开发 · 数据口径未校准</h3>
      <div class="muted" style="font-size:12px">
        这块是刚做的雏形：素材/SKU 的分桶阈值、去重、账户级归因都还没对齐 TikTok 后台口径，
        <b>当前数据可能不准，仅供参考</b>，别直接照着下决策。后续会对齐口径后再正式启用。
      </div>
    </div>
    <div class="kpis" id="diagKpis"></div>
    <div class="card">
      <h3>素材赛马场 <span class="muted" id="diagCreativeHint">待删 / 观察 / 加热，按浪费金额排序</span></h3>
      <div class="horseGrid" id="diagCreative"></div>
    </div>
    <div class="card">
      <h3>SKU 作战室 <span class="muted" id="diagSkuHint">红灯止损 / 黄灯检查 / 绿灯扩量</span></h3>
      <div id="diagSku"></div>
    </div>
  </section>

  <section id="tab-campaigns" hidden>
    <div class="card">
      <h3>广告组 <span class="muted" id="campaignCount"></span></h3>
      <div id="campaignTable" class="scrollbox"></div>
    </div>
    <div class="card" id="drillCard" hidden>
      <h3 id="drillTitle">下钻</h3>
      <div class="grid2">
        <div><h3 style="font-size:12px;color:var(--muted)">商品 / SKU</h3><div id="drillSku" class="scrollbox"></div></div>
        <div>
          <h3 style="font-size:12px;color:var(--muted)">素材
            <input id="drillSearch" class="skuSearch" placeholder="搜索作品ID / 前缀" style="margin-left:8px">
          </h3>
          <div id="drillCreative" class="scrollbox"></div>
        </div>
      </div>
    </div>
  </section>

  <section id="tab-alerts" hidden>
    <div class="card"><h3>当前异常 <span class="muted" id="scanInfo"></span></h3><div id="activeAlerts"></div></div>
    <div class="card"><h3>历史</h3><div id="historyAlerts"></div></div>
  </section>

  <section id="tab-settings" hidden>
    <div class="card">
      <h3>监控范围 <span class="muted" id="watchInfo"></span></h3>
      <div class="tools">
        <label class="chip" id="w-all" style="cursor:pointer">全部账户</label>
        <label class="chip" id="w-sel" style="cursor:pointer">只监控左侧勾选的账户</label>
        <span class="muted">（自动扫描按这个范围；点「立即扫描」则用当前勾选）</span>
      </div>
    </div>
    <div class="card">
      <h3>监控规则</h3>
      <div class="tools">
        <label>窗口 <input id="s-days" size="4"> 天</label>
        <label>消耗 ≥ <input id="s-spend" size="6"> USD</label>
        <label>ROI 目标 <input id="s-roi" size="5"></label>
        <label>低于目标 <input id="s-ratio" size="4"> 倍告警</label>
        <label>扫描间隔 <input id="s-interval" size="4"> 分钟</label>
      </div>
      <div class="tools">
        <label>素材·止损阈值 ≥ <input id="s-creative-spend" size="5"> $（0 单判待删）</label>
        <label>看板·烧钱速度 ≥ <input id="s-speed" size="5"> $/小时（且 0 单告警）</label>
        <label>看板·断流 ≥ <input id="s-stall" size="4"> 分钟告警</label>
      </div>
    </div>
    <div class="card">
      <h3>飞书告警</h3>
      <div class="tools"><input id="s-feishu" style="flex:1;min-width:320px" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/...">
        <button class="act primary" id="btnSave">保存</button><span class="muted" id="saveInfo"></span></div>
    </div>
  </section>
  <footer>本页面由插件在本机启动（仅 127.0.0.1 可访问）；数据来自 TikTok 官方 Ads API。</footer>
</main></div>

<div class="charttip" id="chartTip"></div>

<div class="modal" id="expandModal">
  <div class="sheet" style="width:min(1180px,96vw)">
    <button class="close" id="expandClose">关闭</button>
    <h3 id="expandTitle">素材实时明细</h3>
    <div class="meta" id="expandMeta"></div>
    <div id="expandBody"></div>
  </div>
</div>

<div class="modal" id="modal">
  <div class="sheet">
    <button class="close" id="modalClose">关闭</button>
    <h3 id="modalTitle">详情</h3>
    <div class="meta" id="modalMeta"></div>
    <div class="kpis" id="modalKpis"></div>
    <div class="tools">
      <span class="chips" id="modalRangeChips">
        <button class="chip" data-days="3">3 天</button>
        <button class="chip" data-days="7">7 天</button>
        <button class="chip" data-days="14">14 天</button>
        <button class="chip" data-days="30">30 天</button>
        <button class="chip" data-mode="custom">自定义</button>
      </span>
      <span class="chips" id="modalCustomRange" hidden>
        <input type="date" id="modalStart" title="开始日期">
        <span class="muted">→</span>
        <input type="date" id="modalEnd" title="结束日期">
        <button class="act" id="modalApply">应用</button>
      </span>
      <span class="chips" id="modalMetricChips">
        <button class="chip" data-metric="cost" aria-pressed="true">消耗</button>
        <button class="chip" data-metric="revenue" aria-pressed="false">GMV</button>
        <button class="chip" data-metric="roi" aria-pressed="false">ROI</button>
        <button class="chip" data-metric="orders" aria-pressed="false">订单</button>
      </span>
    </div>
    <div class="chartwrap"><div id="modalChart"></div></div>
  </div>
</div>

<div class="dlg" id="dlg">
  <div class="dlgbox">
    <h3>添加盯盘模块</h3>
    <div class="muted" style="font-size:12px;margin-bottom:12px">一个模块盯一个对象：整个账户 / 某个广告组 / 某个广告组下的多条素材。</div>
    <div class="field"><label>搜索</label>
      <input id="dlgSearch" style="flex:1" placeholder="粘贴 素材ID 或 广告组ID（可多个，空格/逗号分隔）">
      <button class="act" id="dlgSearchGo">搜索</button>
      <button class="act" id="dlgSearchRebuild" title="重建索引（最近 7 天有消耗的对象）">重建索引</button>
    </div>
    <div id="dlgResults" class="muted" style="font-size:12px;margin:-4px 0 10px"></div>
    <div class="field"><label>账户</label><select id="dlgAccount" style="flex:1"></select></div>
    <div class="field"><label>广告组</label><select id="dlgCampaign" style="flex:1"><option value="">（整个账户）</option></select></div>
    <div class="field"><label>素材</label><div style="flex:1" id="dlgItems"><div class="loading">先选账户 / 广告组</div></div></div>
    <div class="field"><label>默认指标</label><select id="dlgLeft"><option value="cost">消耗 + 订单</option><option value="revenue">GMV + 订单</option></select>
      <span class="muted" style="font-size:11.5px">添加后可在卡片上点选任意指标（最多 2 个 → 双 Y 轴）</span></div>
    <div class="field"><label>备注</label><input id="dlgNote" style="flex:1" placeholder="例如：测新素材 / 观察前 3 小时消耗"></div>
    <div class="dlgfoot"><span class="muted" id="dlgStatus"></span>
      <button class="act" id="dlgCancel">取消</button>
      <button class="act primary" id="dlgAdd">添加到看板</button></div>
  </div>
</div>

<script>
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (v) => '$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (v) => Number(v || 0).toLocaleString('en-US');
const pct = (v) => (Number(v) || 0).toFixed(2) + '%';
const roiClass = (roi) => (roi >= 10 ? 'good' : roi >= 5 ? 'warn' : 'bad');
const fmtDate = (d) => { const s = String(d || ''); return /^\d{2}:\d{2}$/.test(s) ? s : s.slice(5); };

const state = { days: 7, today: false, custom: null, tab: 'watch', tz: 'account', timezones: {}, tzTimer: null, drillSort: { field: 'cost', dir: 'desc' }, drillStatus: 'all', drillCreatives: [], drillSearch: '', products: null, expanded: {}, expandedCompare: {}, cardQueue: [], cardBusy: false, compareMetric: 'cost', compareEditor: null, metric: 'cost', selected: new Set(), accounts: [], drill: null, modal: null, watch: { accountId: '', campaignId: '', itemId: '', metric: 'cost', timer: null, campaigns: [] } };

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw new Error(path + ' HTTP ' + res.status);
  return res.json();
}
const accountQuery = () => (state.selected.size ? Array.from(state.selected).join(',') : '');
const rangeQuery = () => {
  const parts = ['days=' + state.days, 'today=' + (state.today ? '1' : '0')];
  if (state.custom && state.custom.start && state.custom.end) {
    parts.push('start=' + encodeURIComponent(state.custom.start), 'end=' + encodeURIComponent(state.custom.end));
  }
  return parts.join('&');
};

/* ---------------- SVG 折线图（无依赖） ---------------- */
function lineChart(seriesList, metric, opts) {
  const width = (opts && opts.width) || 760, height = (opts && opts.height) || 260;
  const pad = { left: 54, right: 16, top: 14, bottom: 26 };
  const innerW = width - pad.left - pad.right, innerH = height - pad.top - pad.bottom;
  const dates = [...new Set(seriesList.flatMap((s) => s.points.map((p) => p.date)))].sort();
  if (!dates.length) return '<div class="empty">暂无数据</div>';
  const valueOf = (point) => Number(point[metric]) || 0;
  const values = seriesList.flatMap((s) => s.points.map(valueOf));
  const maxV = Math.max(1, ...values) * 1.12;
  const x = (date) => pad.left + (dates.length === 1 ? innerW / 2 : (dates.indexOf(date) / (dates.length - 1)) * innerW);
  const y = (value) => pad.top + innerH - (value / maxV) * innerH;
  const ticks = 4;
  const moneyMetric = metric === 'cost' || metric === 'revenue';
  let svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" height="' + height + '" data-w="' + width + '" data-pl="' + pad.left + '" data-pr="' + pad.right + '" preserveAspectRatio="none">';
  for (let i = 0; i <= ticks; i++) {
    const vy = pad.top + (innerH / ticks) * i;
    const label = maxV * (1 - i / ticks);
    svg += '<line x1="' + pad.left + '" x2="' + (width - pad.right) + '" y1="' + vy + '" y2="' + vy + '" stroke="#242a3a" stroke-width="1"/>';
    svg += '<text x="' + (pad.left - 8) + '" y="' + (vy + 4) + '" fill="#8f97a8" font-size="10.5" text-anchor="end">' +
      (moneyMetric ? '$' + Math.round(label) : metric === 'roi' ? label.toFixed(1) : Math.round(label)) + '</text>';
  }
  const step = Math.max(1, Math.ceil(dates.length / 9));
  dates.forEach((date, i) => {
    if (i % step !== 0 && i !== dates.length - 1) return;
    svg += '<text x="' + x(date) + '" y="' + (height - 8) + '" fill="#8f97a8" font-size="10.5" text-anchor="middle">' + esc(fmtDate(date)) + '</text>';
  });
  for (const series of seriesList) {
    const byDate = new Map(series.points.map((p) => [p.date, p]));
    let path = '';
    dates.forEach((date, i) => {
      const point = byDate.get(date);
      if (!point) return;
      path += (path ? ' L' : 'M') + x(date).toFixed(1) + ' ' + y(valueOf(point)).toFixed(1);
      void i;
    });
    if (!path) continue;
    svg += '<path d="' + path + '" fill="none" stroke="' + series.color + '" stroke-width="2" stroke-linejoin="round"/>';
    for (const point of series.points) {
      svg += '<circle cx="' + x(point.date) + '" cy="' + y(valueOf(point)) + '" r="2.6" fill="' + series.color + '"><title>' +
        esc(point.date) + ' · ' + esc(series.name) + ' · ' + (moneyMetric ? money(valueOf(point)) : valueOf(point)) + '</title></circle>';
    }
  }
  svg += '</svg>';
  return svg;
}
function sparkline(points, metric) {
  if (!points || !points.length) return '';
  const values = points.map((p) => Number(p[metric]) || 0);
  const max = Math.max(1, ...values);
  const w = 96, h = 22;
  const path = values.map((v, i) => (i === 0 ? 'M' : 'L') + ((i / Math.max(1, values.length - 1)) * w).toFixed(1) + ' ' + (h - (v / max) * (h - 2) - 1).toFixed(1)).join(' ');
  return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '"><path d="' + path + '" fill="none" stroke="#4f7cff" stroke-width="1.6"/></svg>';
}
const PALETTE = ['#4f7cff', '#2fbf87', '#e7a33c', '#ef4d5a', '#a06bff', '#38bdf8'];
const TZ_LIST = [["account","跟随全局"],["UTC","UTC"],["Europe/London","英国 London"],["Europe/Berlin","德国 Berlin"],["Europe/Paris","法国 Paris"],["Europe/Madrid","西班牙 Madrid"],["Europe/Rome","意大利 Rome"],["America/New_York","美东 New York"],["America/Chicago","美中 Chicago"],["America/Denver","美山 Denver"],["America/Los_Angeles","美西 Los Angeles"],["America/Sao_Paulo","巴西 São Paulo"],["America/Mexico_City","墨西哥 Mexico"],["Asia/Dubai","中东 Dubai"],["Asia/Kolkata","印度 Kolkata"],["Asia/Jakarta","印尼 Jakarta"],["Asia/Singapore","新加坡 Singapore"],["Asia/Manila","菲律宾 Manila"],["Asia/Bangkok","泰国 Bangkok"],["Asia/Ho_Chi_Minh","越南 Vietnam"],["Asia/Shanghai","中国 Shanghai"],["Asia/Tokyo","日本 Tokyo"],["Asia/Seoul","韩国 Seoul"],["Australia/Sydney","澳洲 Sydney"],["Pacific/Auckland","新西兰 Auckland"]];
function TZ_OPTIONS_HTML(current) {
  return TZ_LIST.map(([value, label]) => '<option value="' + value + '"' + (value === current ? ' selected' : '') + '>' + label + '</option>').join('');
}

const CHART_METRICS = {
  cost: { key: 'cost', label: '消耗', color: '#4f7cff', unit: 'money' },
  orders: { key: 'orders', label: '订单', color: '#e7a33c', unit: 'count' },
  revenue: { key: 'revenue', label: 'GMV', color: '#2fbf87', unit: 'money' },
  roi: { key: 'roi', label: 'ROI', color: '#a06bff', unit: 'ratio' },
  cpo: { key: 'cpo', label: '单均', color: '#38bdf8', unit: 'money' },
};

function ensureChartTip() {
  let tip = document.getElementById('chartTip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'chartTip';
    tip.className = 'charttip';
    document.body.appendChild(tip);
  }
  return tip;
}

/**
 * Bind a hover tooltip to a chart: shows every metric value at the hovered time
 * point (instead of relying on the native SVG <title>).
 * @param {Element|null} wrap 元素（含 svg）
 * @param {Array<object>} points 数据点
 * @param {string[]} metricKeys 要展示的指标
 */
function bindChartTip(wrap, points, metricKeys) {
  if (!wrap || !Array.isArray(points) || points.length === 0) return;
  const svg = wrap.querySelector('svg');
  if (!svg || svg.dataset.tipBound) return;
  svg.dataset.tipBound = '1';
  const width = Number(svg.dataset.w) || 760;
  const padLeft = Number(svg.dataset.pl) || 54;
  const padRight = Number(svg.dataset.pr) || 16;
  const tip = ensureChartTip();
  const ns = 'http://www.w3.org/2000/svg';
  let crosshair = svg.querySelector('.crosshair');
  if (!crosshair) {
    crosshair = document.createElementNS(ns, 'line');
    crosshair.setAttribute('class', 'crosshair');
    crosshair.setAttribute('stroke', '#6b7488');
    crosshair.setAttribute('stroke-width', '1');
    crosshair.setAttribute('stroke-dasharray', '3 3');
    crosshair.setAttribute('y1', '12');
    crosshair.setAttribute('y2', String((svg.viewBox.baseVal.height || 240) - 26));
    crosshair.style.display = 'none';
    svg.appendChild(crosshair);
  }
  // 前缀和：截至当前小时的累计消耗/订单
  const cumulative = (() => {
    let cost = 0;
    let orders = 0;
    return points.map((point) => {
      cost += Number(point.cost) || 0;
      orders += Number(point.orders) || 0;
      return { cost, orders };
    });
  })();
  const highlightDots = (pointX) => {
    for (const circle of svg.querySelectorAll('circle')) {
      const cx = Number(circle.getAttribute('cx'));
      if (Math.abs(cx - pointX) <= 1.6) {
        if (!circle.dataset.baseR) circle.dataset.baseR = circle.getAttribute('r') || '2.6';
        circle.setAttribute('r', '4.6');
        circle.setAttribute('stroke', '#0b0d12');
        circle.setAttribute('stroke-width', '1.4');
      } else if (circle.dataset.baseR) {
        circle.setAttribute('r', circle.dataset.baseR);
        circle.removeAttribute('stroke');
        circle.removeAttribute('stroke-width');
      }
    }
  };
  const clearDots = () => {
    for (const circle of svg.querySelectorAll('circle')) {
      if (circle.dataset.baseR) {
        circle.setAttribute('r', circle.dataset.baseR);
        circle.removeAttribute('stroke');
        circle.removeAttribute('stroke-width');
      }
    }
  };
  const fmt = (metric, value) => {
    const meta = CHART_METRICS[metric] || { unit: 'count' };
    if (meta.unit === 'money') return money(value);
    if (meta.unit === 'ratio') return String(Number(value || 0).toFixed(2));
    return num(value);
  };
  const show = (event) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const relativeX = ((event.clientX - rect.left) / rect.width) * width;
    const inner = Math.max(1, width - padLeft - padRight);
    const ratio = Math.min(1, Math.max(0, (relativeX - padLeft) / inner));
    const index = Math.round(ratio * (points.length - 1));
    const point = points[index];
    if (!point) return;
    const rows = metricKeys.map((metric) => {
      const meta = CHART_METRICS[metric] || { label: metric, color: '#8f97a8' };
      return '<div class="r"><i style="background:' + meta.color + '"></i>' + meta.label + '<b>' + fmt(metric, point[metric]) + '</b></div>';
    }).join('');
    const innerSpan = Math.max(1, width - padLeft - padRight);
    const pointX = padLeft + ratio * innerSpan;
    crosshair.setAttribute('x1', String(pointX));
    crosshair.setAttribute('x2', String(pointX));
    crosshair.style.display = '';
    highlightDots(pointX);
    const running = cumulative[index] || { cost: 0, orders: 0 };
    tip.innerHTML = '<div class="t">' + esc(point.hour || point.date || '') + '</div>' + rows +
      '<div class="r sep"><i style="background:#5b6478"></i>截至本小时<b>' + money(running.cost) + ' / ' + num(running.orders) + ' 单</b></div>';
    tip.style.display = 'block';
    const tipWidth = 150;
    const left = event.clientX + 14 + tipWidth > window.innerWidth ? event.clientX - tipWidth - 10 : event.clientX + 14;
    tip.style.left = left + 'px';
    tip.style.top = Math.max(8, event.clientY - 12) + 'px';
  };
  svg.addEventListener('mousemove', show);
  svg.addEventListener('mouseleave', () => { tip.style.display = 'none'; crosshair.style.display = 'none'; clearDots(); });
  wrap.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
}

/** 某个 IANA 时区在指定时刻相对 UTC 的偏移（分钟） */
function zoneOffsetMinutes(timeZone, date = new Date()) {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = formatter.formatToParts(date).reduce((acc, part) => { if (part.type !== 'literal') acc[part.type] = part.value; return acc; }, {});
    const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
    return Math.round((asUtc - date.getTime()) / 60000);
  } catch {
    return 0;
  }
}

function formatInZone(timeZone, date = new Date()) {
  try {
    return new Intl.DateTimeFormat('zh-CN', { timeZone, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
  } catch {
    return date.toLocaleTimeString('zh-CN');
  }
}

/** 把某个账户的小时序列换算到目标时区（accountTz 是 TikTok 报表口径） */
function shiftSeries(points, accountTz, targetTz) {
  if (!points || !points.length || !targetTz || targetTz === 'account') return points;
  const fromOffset = zoneOffsetMinutes(accountTz || 'UTC');
  const toOffset = zoneOffsetMinutes(targetTz);
  const shift = (toOffset - fromOffset) / 60;
  if (!shift) return points;
  // 只换标签、不打乱顺序：数据点的顺序对应账户时区的自然时间流，
  // 跨天时标签会绕回 00:00..，这样曲线形状不变、横轴显示目标时区。
  return points.map((point) => {
    const raw = String(point.hour || '');
    const hour = Number(raw.slice(0, 2));
    if (Number.isNaN(hour)) return point;
    const next = ((hour + shift) % 24 + 24) % 24;
    const label = String(Math.round(next)).padStart(2, '0') + raw.slice(2);
    return { ...point, hour: label, date: label };
  });
}

const spinnerHtml = (label) => '<div class="loadingBox"><span class="spinner"></span>' + esc(label || '加载中…') + '</div>';
const postUrl = (itemId) => 'https://www.tiktok.com/video/' + encodeURIComponent(itemId);
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    const node = $('#boardStatus');
    if (node) node.textContent = '已复制作品ID ' + text + '（可到商家中心搜索）';
  } catch {
    window.prompt('复制这个作品ID:', text);
  }
}
const STATUS_META = {
  kill: { label: '待删', cls: 'bad' },
  watch: { label: '观察', cls: 'warn' },
  scale: { label: '加热', cls: 'good' },
  normal: { label: '正常', cls: '' },
};

/* ---------------- 账户 ---------------- */
async function loadAccounts() {
  const data = await api('/api/accounts');
  state.accounts = data.accounts || [];
  const box = $('#accountList');
  if (!state.accounts.length) { box.innerHTML = '<div class="empty">未授权或没有可跑的店铺</div>'; return; }
  box.innerHTML = '<label class="acct"><input type="checkbox" id="chkAll" checked> 全部合并 <small>合并看</small></label>' +
    state.accounts.map((account) => '<label class="acct"><input type="checkbox" data-account="' + esc(account.advertiserId) + '"> ' +
      esc(account.storeName) + ' <small>' + esc(String(account.advertiserName).slice(0, 6)) + '</small></label>').join('');
  $('#chkAll').addEventListener('change', () => {
    state.selected.clear();
    for (const el of document.querySelectorAll('[data-account]')) el.checked = false;
    $('#pageSub').textContent = '全部账户合并';
    render();
  });
  for (const el of document.querySelectorAll('[data-account]')) {
    el.addEventListener('change', () => {
      if (el.checked) state.selected.add(el.dataset.account); else state.selected.delete(el.dataset.account);
      $('#chkAll').checked = state.selected.size === 0;
      $('#pageSub').textContent = state.selected.size === 0
        ? '全部账户合并'
        : state.selected.size === 1
          ? '单账户：' + ((state.accounts.find((a) => a.advertiserId === Array.from(state.selected)[0]) || {}).storeName || '')
          : state.selected.size + ' 个账户分开对比';
      render();
    });
  }
  $('#pageSub').textContent = '全部账户合并';
}

/* ---------------- 展示台 ---------------- */
async function renderDesk() {
  const data = await api('/api/desk?' + rangeQuery() + '&accounts=' + encodeURIComponent(accountQuery()));
  const totals = data.totals;
  $('#kpis').innerHTML = [
    ['消耗', money(totals.cost)], ['订单', num(totals.orders)], ['GMV', money(totals.revenue)],
    ['ROI', '<span class="' + roiClass(totals.roi) + '">' + totals.roi + '</span>'], ['单均成本', money(totals.costPerOrder)],
  ].map(([k, v]) => '<div class="kpi"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>').join('');

  const split = data.accounts.length > 1;
  const series = split
    ? data.accounts.map((row, index) => ({ name: row.name, color: PALETTE[index % PALETTE.length], points: row.series || [] }))
    : [{ name: data.accounts[0] ? data.accounts[0].name : '合计', color: PALETTE[0], points: data.mergedSeries || [] }];
  $('#chartHint').textContent = (data.range && data.range.today ? '今日按小时 · ' : '') + (split ? '按账户分开对比（' + data.accounts.length + ' 条线）' : '合并视图');
  $('#mainChart').innerHTML = lineChart(series, state.metric, { width: 820, height: 280 });
  {
    const merged = new Map();
    for (const item of series) {
      for (const point of item.points || []) {
        const bucket = merged.get(point.date) || { date: point.date, hour: point.hour || point.date, cost: 0, orders: 0, revenue: 0 };
        bucket.cost += Number(point.cost) || 0;
        bucket.orders += Number(point.orders) || 0;
        bucket.revenue += Number(point.revenue) || 0;
        bucket.roi = bucket.cost > 0 ? Number((bucket.revenue / bucket.cost).toFixed(2)) : 0;
        merged.set(point.date, bucket);
      }
    }
    const deskPoints = [...merged.values()].sort((left, right) => String(left.date).localeCompare(String(right.date)));
    bindChartTip($('#mainChart'), deskPoints, ['cost', 'orders', 'revenue', 'roi']);
  }
  $('#mainLegend').innerHTML = split
    ? series.map((s) => '<span><i style="background:' + s.color + '"></i>' + esc(s.name) + '</span>').join('')
    : '<span><i style="background:' + PALETTE[0] + '"></i>' + esc(series[0].name) + '</span>';

  $('#accountTable').innerHTML = data.accounts.length ? '<table><thead><tr><th>账户</th><th class="num">消耗</th><th class="num">订单</th><th class="num">GMV</th><th class="num">ROI</th><th class="num">单均</th></tr></thead><tbody>' +
    data.accounts.map((row) => '<tr class="click" data-drill-account="' + esc(row.advertiserId) + '"><td title="' + esc(row.name) + '">' + esc(row.name) + '</td><td class="num">' + money(row.cost) +
      '</td><td class="num">' + num(row.orders) + '</td><td class="num">' + money(row.revenue) + '</td><td class="num ' + roiClass(row.roi) + '">' + row.roi + '</td><td class="num">' + money(row.costPerOrder) + '</td></tr>').join('') +
    '</tbody></table>' : '<div class="empty">暂无数据</div>';
  for (const tr of document.querySelectorAll('[data-drill-account]')) {
    tr.addEventListener('click', () => {
      const account = data.accounts.find((entry) => entry.advertiserId === tr.dataset.drillAccount);
      openModal({ kind: 'account', advertiserId: tr.dataset.drillAccount, name: account ? account.name : '账户', days: state.days });
    });
  }
}


/* ---------------- 盯盘看板（模块化） ---------------- */
const board = { modules: [], data: [], timer: null, editing: null, pick: { advertiserId: '', campaignId: '', items: new Set(), note: '', leftMetric: 'cost', campaignName: '', itemNames: {} } };

async function renderWatch() {
  // 先用手上（或上次会话）的数据立刻画出来，再后台刷新，避免切回盯盘时一片空白
  if (!board.modules.length) {
    try {
      const cached = JSON.parse(sessionStorage.getItem('tiktok-ads-board-cache') || 'null');
      if (cached && Array.isArray(cached) && cached.length) {
        board.data = cached;
        renderBoardCards();
        $('#boardHint').hidden = true;
      }
    } catch { /* ignore */ }
  }
  await refreshBoard();
  restartBoardTimer();
  setIntervalBoardCountdown();
}

function boardInterval() {
  const stored = Number(localStorage.getItem('tiktok-ads-board-interval'));
  return [15, 30, 60].includes(stored) ? stored : 60;
}

function restartBoardTimer() {
  if (board.timer) clearInterval(board.timer);
  const seconds = boardInterval();
  board.timer = setInterval(() => { if (state.tab === 'watch') refreshBoard(); }, seconds * 1000);
}

let boardCountdown = null;
function setIntervalBoardCountdown() {
  if (boardCountdown) clearInterval(boardCountdown);
  let remaining = boardInterval();
  boardCountdown = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) remaining = boardInterval();
    const node = $('#boardLive');
    if (node) node.textContent = '自动刷新 ' + boardInterval() + 's · 倒计时 ' + remaining + 's';
  }, 1000);
}

function exportBoardCsv() {
  const rows = [['模块', '类型', '账户', '广告组', '素材ID', '今日消耗', '订单', 'GMV', 'ROI', '单均', '备注']];
  for (const entry of board.data) {
    const module = entry.module || {};
    const totals = entry.totals || {};
    rows.push([
      entry.label || '',
      module.kind === 'account' ? '户' : module.kind === 'campaign' ? '组' : '素材',
      module.storeName || '',
      module.campaignName || '',
      (module.itemIds || []).join(' '),
      totals.cost || 0,
      totals.orders || 0,
      totals.revenue || 0,
      totals.roi || 0,
      totals.costPerOrder || 0,
      module.note || '',
    ]);
  }
  const csv = rows.map((row) => row.map((cell) => '"' + String(cell).replace(/"/g, '""') + '"').join(',')).join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = '盯盘看板_' + new Date().toISOString().slice(0, 10) + '.csv';
  link.click();
}

async function loadTimezones() {
  try {
    const data = await api('/api/timezones');
    state.timezones = {};
    for (const row of data.accounts || []) state.timezones[row.advertiserId] = row.timezone || 'UTC';
    state.timezoneList = data.accounts || [];
  } catch { /* 时区拿不到就按 UTC 展示 */ }
}

function timezoneForAccount(advertiserId) {
  if (state.tz !== 'account' && state.tz) return state.tz;
  return state.timezones[advertiserId] || 'UTC';
}

function startTzClock() {
  if (state.tzTimer) clearInterval(state.tzTimer);
  const tick = () => {
    const zone = state.tz !== 'account' && state.tz ? state.tz : (state.timezones[Object.keys(state.timezones)[0]] || 'UTC');
    const node = $('#tzClock');
    if (node) node.textContent = formatInZone(zone);
    for (const clock of document.querySelectorAll('[data-card-clock]')) {
      const moduleId = clock.dataset.cardClock;
      const module = (board.modules || []).find((item) => item.id === moduleId);
      const cardZone = (module && module.tz && module.tz !== 'account')
        ? module.tz
        : (state.tz !== 'account' && state.tz ? state.tz : (state.timezones[(module && module.advertiserId) || ''] || 'UTC'));
      clock.textContent = formatInZone(cardZone);
    }
  };
  tick();
  state.tzTimer = setInterval(tick, 1000);
}

/** 素材实时数据：一次拉全部（服务端 45 秒缓存），所有卡片共用 */
async function loadCreativeBoard() {
  const now = Date.now();
  if (state.creativeBoard && now - (state.creativeBoardAt || 0) < 45_000) return;
  try {
    const data = await api('/api/creative-board?' + rangeQuery());
    state.creativeBoard = data;
    state.creativeBoardAt = now;
  } catch (error) {
    console.warn('素材看板加载失败', error);
  }
}

async function refreshBoard(options = {}) {
  try {
    // 一次请求拿全部（/api/board/data 自带模块元数据），不再「先列表再数据」两趟
    const data = await api('/api/board/data');
    board.data = data.modules || [];
    board.modules = board.data.map((entry) => entry.module).filter(Boolean);
    if (!board.data.length) {
      $('#boardGrid').innerHTML = '';
      $('#boardHint').hidden = false;
      const emptySummary = $('#boardSummary');
      if (emptySummary) emptySummary.textContent = '暂无模块';
      return;
    }
    $('#boardHint').hidden = true;
    try { sessionStorage.setItem('tiktok-ads-board-cache', JSON.stringify(board.data)); } catch { /* quota */ }
    const alertCount = board.data.reduce((sum, entry) => sum + (entry.alerts ? entry.alerts.length : 0), 0);
    const summary = $('#boardSummary');
    if (summary) summary.textContent = board.data.length + ' 个模块' + (alertCount ? ' · ' + alertCount + ' 条告警' : ' · 无告警');
    renderBoardCards();
    void options;
  } catch (error) {
    $('#boardHint').hidden = false;
    $('#boardHint').textContent = '加载失败：' + error.message;
  }
}

function renderBoardCards() {
  const grid = $('#boardGrid');
  grid.innerHTML = board.data.map((entry) => boardCard(entry)).join('');
  const cardNodes = grid.querySelectorAll('.bcard');
  board.data.forEach((entry, index) => {
    const node = cardNodes[index];
    if (!node) return;
    const metrics = (entry.module && entry.module.metrics && entry.module.metrics.length ? entry.module.metrics : ['cost', 'orders']);
    const cardTz = state.timezones[(entry.module && entry.module.advertiserId) || ''] || 'UTC';
    const cardTarget = entry.module && entry.module.tz && entry.module.tz !== 'account' ? entry.module.tz : state.tz;
    bindChartTip(node.querySelector('.chartwrap'), shiftSeries(entry.series || [], cardTz, cardTarget), metrics);
  });
  for (const button of grid.querySelectorAll('[data-module-remove]')) {
    button.addEventListener('click', async () => {
      const entry = board.data.find((item) => item.module && item.module.id === button.dataset.moduleRemove);
      const label = entry ? entry.label : '这个模块';
      if (!window.confirm('删除盯盘模块「' + label + '」？')) return;
      const id = button.dataset.moduleRemove;
      // 本地先行：立刻从界面移除，后台再删，失败回滚
      const snapshot = board.data.slice();
      board.data = board.data.filter((entry) => !entry.module || entry.module.id !== id);
      board.modules = board.data.map((entry) => entry.module).filter(Boolean);
      renderBoardCards();
      try {
        await api('/api/board/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
        refreshBoard({ silent: true });
      } catch (error) {
        board.data = snapshot;
        renderBoardCards();
        alert('删除失败：' + error.message);
      }
    });
  }
  for (const note of grid.querySelectorAll('[data-module-note]')) {
    note.addEventListener('blur', async () => {
      const id = note.dataset.moduleNote;
      await api('/api/board/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, note: note.value }) });
      $('#boardStatus').textContent = '备注已保存';
    });
  }
  for (const tile of grid.querySelectorAll('[data-kpi-metric]')) {
    tile.addEventListener('click', async () => {
      const holder = tile.closest('[data-module-metrics]');
      const moduleId = holder ? holder.dataset.moduleMetrics : '';
      const module = board.modules.find((candidate) => candidate.id === moduleId);
      if (!module) return;
      const metric = tile.dataset.kpiMetric;
      let metrics = Array.isArray(module.metrics) && module.metrics.length ? [...module.metrics] : ['cost', 'orders'];
      if (metrics.includes(metric)) {
        if (metrics.length === 1) return; // 至少留一个
        metrics = metrics.filter((item) => item !== metric);
      } else {
        metrics = [...metrics, metric].slice(-2);
      }
      module.metrics = metrics;
      const entry = board.data.find((item) => item.module && item.module.id === moduleId);
      if (entry) entry.module = { ...entry.module, metrics };
      renderBoardCards();
      try {
        await api('/api/board/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: moduleId, metrics }) });
        $('#boardStatus').textContent = '指标已更新（已保存）';
      } catch (error) {
        $('#boardStatus').textContent = '保存失败：' + error.message;
      }
    });
  }
  for (const select of grid.querySelectorAll('[data-module-left]')) {
    select.addEventListener('change', async () => {
      await api('/api/board/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: select.dataset.moduleLeft, leftMetric: select.value }) });
      refreshBoard();
    });
  }
  for (const input of grid.querySelectorAll('[data-compare-toggle]')) {
    input.addEventListener('change', async (event) => {
      event.stopPropagation();
      const id = input.dataset.compareToggle;
      const module = board.modules.find((candidate) => candidate.id === id);
      if (!module) return;
      if (input.checked) {
        module.compare = 'date';
        if (!module.compareDate) {
          const yesterday = new Date(Date.now() - 86_400_000);
          const pad2 = (value) => String(value).padStart(2, '0');
          module.compareDate = yesterday.getFullYear() + '-' + pad2(yesterday.getMonth() + 1) + '-' + pad2(yesterday.getDate());
        }
        state.compareEditor = id;
      } else {
        module.compare = 'off';
        state.compareEditor = null;
      }
      const entry = board.data.find((item) => item.module && item.module.id === id);
      if (entry) entry.module = { ...entry.module, compare: module.compare, compareDate: module.compareDate };
      renderBoardCards();
      await api('/api/board/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, compare: module.compare, compareDate: module.compareDate }) });
    });
  }
  for (const button of grid.querySelectorAll('[data-compare-expand]')) {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      state.compareEditor = state.compareEditor === button.dataset.compareExpand ? null : button.dataset.compareExpand;
      renderBoardCards();
    });
  }
  for (const input of grid.querySelectorAll('[data-compare-date]')) {
    input.addEventListener('change', async (event) => {
      event.stopPropagation();
      const id = input.dataset.compareDate;
      const module = board.modules.find((candidate) => candidate.id === id);
      if (!module || !input.value) return;
      module.compare = 'date';
      module.compareDate = input.value;
      const entry = board.data.find((item) => item.module && item.module.id === id);
      if (entry) entry.module = { ...entry.module, compare: 'date', compareDate: input.value };
      renderBoardCards();
      await api('/api/board/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, compare: 'date', compareDate: input.value }) });
    });
  }
  for (const button of grid.querySelectorAll('[data-compare-quick]')) {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const id = button.dataset.moduleId;
      const module = board.modules.find((candidate) => candidate.id === id);
      if (!module) return;
      const days = button.dataset.compareQuick === '2days' ? 2 : button.dataset.compareQuick === '7days' ? 7 : 1;
      const target = new Date(Date.now() - days * 86_400_000);
      const pad2 = (value) => String(value).padStart(2, '0');
      const date = target.getFullYear() + '-' + pad2(target.getMonth() + 1) + '-' + pad2(target.getDate());
      module.compare = 'date';
      module.compareDate = date;
      const entry = board.data.find((item) => item.module && item.module.id === id);
      if (entry) entry.module = { ...entry.module, compare: 'date', compareDate: date };
      renderBoardCards();
      await api('/api/board/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, compare: 'date', compareDate: date }) });
    });
  }
  for (const node of grid.querySelectorAll('[data-compare-wrap]')) loadCompare(node.dataset.compareWrap);
  for (const button of grid.querySelectorAll('[data-module-view]')) {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const id = button.dataset.moduleView;
      const module = board.modules.find((candidate) => candidate.id === id);
      if (!module) return;
      const current = module.view || (module.kind === 'items' ? 'items' : 'chart');
      const next = current === 'items' ? 'chart' : 'items';
      module.view = next;
      const entry = board.data.find((item) => item.module && item.module.id === id);
      if (entry) entry.module = { ...entry.module, view: next };
      renderBoardCards();
      await api('/api/board/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, view: next }) });
    });
  }
  for (const select of grid.querySelectorAll('[data-card-tz]')) {
    select.addEventListener('change', async (event) => {
      event.stopPropagation();
      const id = select.dataset.cardTz;
      const module = board.modules.find((candidate) => candidate.id === id);
      if (module) module.tz = select.value;
      const entry = board.data.find((item) => item.module && item.module.id === id);
      if (entry) entry.module = { ...entry.module, tz: select.value };
      renderBoardCards();
      startTzClock();
      await api('/api/board/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, tz: select.value }) });
    });
  }
  for (const button of grid.querySelectorAll('[data-module-expand]')) {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      openExpandModal(button.dataset.moduleExpand);
    });
  }
  for (const button of grid.querySelectorAll('[data-module-width]')) {
    button.addEventListener('click', async () => {
      const id = button.dataset.moduleWidth;
      const module = board.modules.find((candidate) => candidate.id === id);
      if (!module) return;
      const width = module.width === 'half' ? 'full' : 'half';
      module.width = width;
      const entry = board.data.find((item) => item.module && item.module.id === id);
      if (entry) entry.module = { ...entry.module, width };
      renderBoardCards();
      await api('/api/board/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, width }) });
    });
  }
  for (const button of document.querySelectorAll('[data-copy-item]')) {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      await copyText(button.dataset.copyItem);
    });
  }
  for (const button of grid.querySelectorAll('[data-module-refresh]')) {
    button.addEventListener('click', refreshBoard);
  }
}

function boardCard(entry) {
  const module = entry.module || {};
  if (entry.loading) {
    return '<div class="card bcard"><div class="bhead"><div class="btitle">' + esc(entry.label || module.label || '新模块') + '</div>' +
      '<span class="muted" style="font-size:11.5px">正在拉取数据…</span></div>' +
      spinnerHtml('首次加载约 3~10 秒') + '</div>';
  }
  const totals = entry.totals || { cost: 0, orders: 0, revenue: 0, roi: 0, costPerOrder: 0 };
  const leftMetric = module.leftMetric === 'revenue' ? 'revenue' : 'cost';
  const leftLabel = leftMetric === 'revenue' ? 'GMV' : '消耗';
  const view = module.view === 'chart' ? 'chart' : 'items';
  const accountTz = state.timezones[module.advertiserId] || 'UTC';
  const targetTz = module.tz && module.tz !== 'account' ? module.tz : state.tz;
  const points = shiftSeries(entry.series || [], accountTz, targetTz);
  const chain = [
    esc(module.storeName || module.accountName || module.advertiserId || '账户'),
    module.campaignName ? esc(module.campaignName) : (module.campaignId ? esc(module.campaignId) : ''),
    module.itemIds && module.itemIds.length ? (module.itemIds.length === 1 ? '素材 ' + esc(String(module.itemIds[0]).slice(-8)) : '素材 ' + module.itemIds.map((id) => esc(String(id).slice(-6))).join(' + ')) : '',
  ].filter(Boolean).join(' <span class="muted">›</span> ');
  const errorLine = entry.error ? '<div class="bad" style="font-size:11.5px;margin-bottom:6px">' + esc(entry.error) + '</div>' : '';
  const sampledHint = entry.sampled && points.length < 3 && !entry.error
    ? '<div class="muted" style="font-size:11.5px;margin-bottom:6px">采样中：每分钟记录一个累计值，曲线会随数据累积画出来（TikTok 不提供素材级小时数据）</div>'
    : '';
  const itemList = entry.items && entry.items.length
    ? '<div class="bItems">' + entry.items.map((item) =>
      '<div class="bItem">' +
        '<span class="pid" data-copy-item="' + esc(item.itemId) + '" title="点击复制作品ID">' + esc(item.itemId) + '</span>' +
        '<span class="muted">' + money(item.cost) + ' · ' + num(item.orders) + ' 单 · ROI ' + item.roi + '</span>' +
        '<button class="act" data-copy-item="' + esc(item.itemId) + '">复制</button>' +
      '</div>').join('') + '</div>'
    : '';
  const compareMode = module.compare || 'off';
  const chartBlock = compareMode === 'off'
    ? '<div class="chartwrap">' + (points.length ? metricChart(points, module) : '<div class="empty">今天还没有数据</div>') + '</div>'
    : '<div class="chartwrap compareWrap" data-compare-wrap="' + esc(module.id || '') + '">' + spinnerHtml('拉取对比数据…') + '</div>';
  return '<div class="card bcard ' + (module.width === 'half' ? 'half' : 'full') + '">' +
    '<div class="bhead"><div class="btitle" title="' + esc(entry.label || '') + '">' + chain + '</div>' +
      '<span class="badge kind-' + esc(module.kind) + '">' + (module.kind === 'account' ? '户' : module.kind === 'campaign' ? '组' : '素材') + '</span>' +
      '<span class="cardClockBig" data-card-clock="' + esc(module.id || '') + '">--:--:--</span>' +
      '<select class="cardTz" data-card-tz="' + esc(module.id || '') + '" title="这张卡片使用的时区">' +
        TZ_OPTIONS_HTML(module.tz || 'account') +
      '</select>' +
      '<button class="act" data-module-expand="' + esc(module.id || '') + '">展开素材</button>' +
      '<button class="act" data-module-remove="' + esc(module.id || '') + '" title="删除模块">删除</button>' +
    '</div>' +
    '<div class="bkpis" data-module-metrics="' + esc(module.id || '') + '">' +
      kpiTile(module, 'cost', '今日消耗', money(totals.cost)) +
      kpiTile(module, 'orders', '订单', num(totals.orders)) +
      kpiTile(module, 'revenue', 'GMV', money(totals.revenue)) +
      kpiTile(module, 'roi', 'ROI', '<b class="' + roiClass(totals.roi) + '">' + (totals.roi || 0) + '</b>') +
      kpiTile(module, 'cpo', '单均', money(totals.costPerOrder)) +
    '</div>' +
    '<div class="cmpBar">' +
      '<label class="cmpToggle"><input type="checkbox" data-compare-toggle="' + esc(module.id || '') + '"' + (compareMode === 'off' ? '' : ' checked') + '> 日期对比</label>' +
      (compareMode === 'off'
        ? '<span class="muted">勾选后与指定日期同指标对比</span>'
        : '<span class="cmpDateText">' + esc(module.compareDate || '昨天') + '</span>' +
          '<button class="act" data-compare-expand="' + esc(module.id || '') + '">' + (state.compareEditor === module.id ? '收起' : '展开') + '</button>' +
          '<span class="muted">指标跟随今日数据源（' + esc(primaryMetricLabel(module)) + '）</span>') +
    '</div>' +
    (compareMode !== 'off' && state.compareEditor === module.id
      ? '<div class="cmpEditor" data-compare-editor="' + esc(module.id || '') + '">' +
          '<span class="muted">对比日期</span>' +
          '<input type="date" data-compare-date="' + esc(module.id || '') + '" value="' + esc(module.compareDate || '') + '">' +
          '<button class="act" data-compare-quick="yesterday" data-module-id="' + esc(module.id || '') + '">昨天</button>' +
          '<button class="act" data-compare-quick="2days" data-module-id="' + esc(module.id || '') + '">前天</button>' +
          '<button class="act" data-compare-quick="7days" data-module-id="' + esc(module.id || '') + '">7 天前</button>' +
        '</div>'
      : '') +
    errorLine + alertsBanner(entry) + sampledHint +
    chartBlock +
    '<div class="blive">' + liveLine(entry) + '</div>' +
    '<div class="brow">' +
      '<span class="bsig">备注</span>' +
      '<input class="bnote" data-module-note="' + esc(module.id || '') + '" placeholder="备注：这个对象在测什么 / 观察到什么" value="' + esc(module.note || '') + '">' +
    '</div>' +
    itemList +
  '</div>';
}

function alertsBanner(entry) {
  const alerts = entry.alerts || [];
  if (!alerts.length) return '';
  return '<div class="balerts">' + alerts.map((alert) =>
    '<div class="a ' + esc(alert.level || 'warning') + '">⚠ ' + esc(alert.message) + '</div>').join('') + '</div>';
}

function liveLine(entry) {
  const live = entry.live || {};
  if (!live || live.deltaCost === null || live.deltaCost === undefined) {
    return '<span class="muted">较上次 —</span>';
  }
  const parts = [];
  parts.push('较上次 ' + (live.deltaCost >= 0 ? '+' : '') + money(live.deltaCost) + (live.deltaOrders ? ' / ' + (live.deltaOrders > 0 ? '+' : '') + live.deltaOrders + ' 单' : ''));
  if (live.perHour !== null && live.perHour !== undefined && live.perHour > 0) parts.push('≈ ' + money(live.perHour) + '/小时');
  if (live.currentHourCost > 0) parts.push('本小时 ' + money(live.currentHourCost) + ' / ' + num(live.currentHourOrders) + ' 单');
  if (!live.currentHourCost && live.lastHour) parts.push('最近消耗在 ' + live.lastHour);
  return parts.join(' · ');
}

const METRIC_META = {
  cost: { label: '消耗', color: '#4f7cff', unit: 'money' },
  orders: { label: '订单', color: '#e7a33c', unit: 'count' },
  revenue: { label: 'GMV', color: '#2fbf87', unit: 'money' },
  roi: { label: 'ROI', color: '#a06bff', unit: 'ratio' },
  cpo: { label: '单均', color: '#38bdf8', unit: 'money' },
};

function kpiTile(module, metric, label, value) {
  const selected = (module.metrics || ['cost', 'orders']).includes(metric);
  return '<span data-kpi-metric="' + metric + '" class="' + (selected ? 'on' : '') + '"><i>' + label + '</i><b>' + value + '</b></span>';
}

/** 选中 1 个指标 → 单轴；2 个 → 双 Y 轴（各自按最大值对齐）。 */
function metricChart(points, module) {
  const metrics = (module.metrics && module.metrics.length ? module.metrics : ['cost', 'orders']).filter((metric) => METRIC_META[metric]);
  if (!metrics.length) metrics.push('cost');
  const width = 760, height = 240;
  const pad = { left: 56, right: metrics.length > 1 ? 56 : 20, top: 14, bottom: 26 };
  const innerW = width - pad.left - pad.right, innerH = height - pad.top - pad.bottom;
  const valueOf = (point, metric) => Number(point[metric]) || 0;
  const axisOf = (metric) => {
    const values = points.map((point) => valueOf(point, metric));
    return { max: Math.max(1, ...values) * 1.12, unit: METRIC_META[metric].unit };
  };
  const leftMetric = metrics[0];
  const rightMetric = metrics[1] || null;
  const leftAxis = axisOf(leftMetric);
  const rightAxis = rightMetric ? axisOf(rightMetric) : null;
  const x = (index) => pad.left + (points.length === 1 ? innerW / 2 : (index / (points.length - 1)) * innerW);
  const yLeft = (value) => pad.top + innerH - (value / leftAxis.max) * innerH;
  const yRight = (value) => pad.top + innerH - (value / (rightAxis ? rightAxis.max : 1)) * innerH;
  const fmtAxis = (value, unit) => unit === 'money' ? '$' + Math.round(value) : unit === 'ratio' ? value.toFixed(1) : Math.round(value);
  const ticks = 4;
  let svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" height="' + height + '" data-w="' + width + '" data-pl="' + pad.left + '" data-pr="' + pad.right + '">';
  for (let i = 0; i <= ticks; i++) {
    const y = pad.top + (innerH / ticks) * i;
    svg += '<line x1="' + pad.left + '" x2="' + (width - pad.right) + '" y1="' + y + '" y2="' + y + '" stroke="#242a3a"/>';
    svg += '<text x="' + (pad.left - 10) + '" y="' + (y + 4) + '" fill="' + METRIC_META[leftMetric].color + '" font-size="10.5" text-anchor="end">' + fmtAxis(leftAxis.max * (1 - i / ticks), leftAxis.unit) + '</text>';
    if (rightAxis) {
      svg += '<text x="' + (width - pad.right + 10) + '" y="' + (y + 4) + '" fill="' + METRIC_META[rightMetric].color + '" font-size="10.5">' + fmtAxis(rightAxis.max * (1 - i / ticks), rightAxis.unit) + '</text>';
    }
  }
  const step = Math.max(1, Math.ceil(points.length / 9));
  points.forEach((point, index) => {
    if (index % step !== 0 && index !== points.length - 1) return;
    svg += '<text x="' + x(index) + '" y="' + (height - 8) + '" fill="#8f97a8" font-size="10.5" text-anchor="middle">' + esc(point.hour || point.date || '') + '</text>';
  });
  const drawSeries = (metric, yScale, dashed) => {
    const color = METRIC_META[metric].color;
    const path = points.map((point, index) => (index === 0 ? 'M' : 'L') + x(index).toFixed(1) + ' ' + yScale(valueOf(point, metric)).toFixed(1)).join(' ');
    let out = '<path d="' + path + '" fill="none" stroke="' + color + '" stroke-width="2"' + (dashed ? ' stroke-dasharray="4 3"' : '') + '/>';
    points.forEach((point, index) => {
      const value = valueOf(point, metric);
      out += '<circle cx="' + x(index) + '" cy="' + yScale(value).toFixed(1) + '" r="2.6" fill="' + color + '"><title>' +
        esc(point.hour || point.date || '') + ' · ' + METRIC_META[metric].label + ' ' + (METRIC_META[metric].unit === 'money' ? money(value) : value) + '</title></circle>';
    });
    return out;
  };
  svg += drawSeries(leftMetric, yLeft, false);
  if (rightMetric) svg += drawSeries(rightMetric, yRight, true);
  svg += '</svg>';
  const legend = metrics.map((metric, index) =>
    '<span><i style="background:' + METRIC_META[metric].color + '"></i>' + METRIC_META[metric].label + '（' + (index === 0 ? '左轴' : '右轴') + '）</span>').join('');
  return svg + '<div class="legend">' + legend + '</div>';
}

/* ---------- 添加盯盘模块 dialog ---------- */
function openAddModule(prefill) {
  board.pick = { advertiserId: prefill?.advertiserId || '', campaignId: prefill?.campaignId || '', items: new Set(prefill?.itemId ? [prefill.itemId] : []), note: '', leftMetric: 'cost', campaignName: '', itemNames: {} };
  $('#dlg').setAttribute('open', 'true');
  $('#dlgAccount').innerHTML = state.accounts.map((account) =>
    '<option value="' + esc(account.advertiserId) + '">' + esc(account.storeName) + ' · ' + esc(account.advertiserName) + '</option>').join('');
  if (board.pick.advertiserId) $('#dlgAccount').value = board.pick.advertiserId;
  $('#dlgNote').value = '';
  $('#dlgSearch').value = '';
  $('#dlgResults').innerHTML = '';
  $('#dlgStatus').textContent = '';
  $('#dlgItems').innerHTML = '<div class="loading">先选账户 / 广告组</div>';
  loadDlgCampaigns();
}
async function loadDlgCampaigns() {
  const advertiserId = $('#dlgAccount').value;
  board.pick.advertiserId = advertiserId;
  const select = $('#dlgCampaign');
  select.innerHTML = '<option value="">（整个账户）</option>';
  try {
    const data = await api('/api/campaigns?days=7&accounts=' + encodeURIComponent(advertiserId));
    for (const row of data.rows) {
      select.innerHTML += '<option value="' + esc(row.campaignId) + '">' + esc(row.name) + '</option>';
    }
  } catch (error) { /* ignore */ }
  select.value = board.pick.campaignId || '';
  await loadDlgItems();
}
async function loadDlgItems() {
  const advertiserId = $('#dlgAccount').value;
  const campaignId = $('#dlgCampaign').value;
  board.pick.campaignId = campaignId;
  const box = $('#dlgItems');
  if (!campaignId) { box.innerHTML = '<div class="muted" style="font-size:12px">不选广告组 = 盯整个账户（无需勾素材）</div>'; return; }
  box.innerHTML = '<div class="loading">加载素材…</div>';
  try {
    const data = await api('/api/campaign-detail?days=1&light=1&advertiser=' + encodeURIComponent(advertiserId) + '&campaign=' + encodeURIComponent(campaignId));
    const items = data.creatives || [];
    box.innerHTML = items.length
      ? '<div class="muted" style="font-size:12px;margin-bottom:6px">可多选（最多 8 条）：已选 <b id="dlgCount">' + board.pick.items.size + '</b> 条</div>' +
        '<div class="itemlist">' + items.map((item) =>
          '<label class="itemrow" title="作品ID：' + esc(item.itemId) + '">' +
          '<input type="checkbox" data-dlg-item="' + esc(item.itemId) + '"' + (board.pick.items.has(item.itemId) ? ' checked' : '') + '> ' +
          '<span class="itemid">' + esc(item.itemId) + '</span>' +
          '<span class="muted">' + money(item.cost) + ' / ' + num(item.orders) + ' 单 / ROI ' + item.roi + '</span></label>').join('') + '</div>'
      : '<div class="muted">该广告组今天没有素材消耗</div>';
    for (const checkbox of box.querySelectorAll('[data-dlg-item]')) {
      checkbox.addEventListener('change', () => {
        const id = checkbox.dataset.dlgItem;
        if (checkbox.checked) {
          if (board.pick.items.size >= 8) { checkbox.checked = false; return; }
          board.pick.items.add(id);
        } else board.pick.items.delete(id);
        const count = $('#dlgCount');
        if (count) count.textContent = board.pick.items.size;
      });
    }
  } catch (error) {
    box.innerHTML = '<div class="bad">素材加载失败：' + esc(error.message) + '</div>';
  }
}
async function runSearch(rebuild) {
  const query = $('#dlgSearch').value.trim();
  if (!query) return;
  const box = $('#dlgResults');
  box.innerHTML = '<span class="muted">搜索中…（首次会建索引，约 30~90 秒）</span>';
  try {
    const data = await api('/api/board/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, rebuild: Boolean(rebuild) }),
    });
    const matches = data.matches || [];
    if (!matches.length) {
      box.innerHTML = '<span class="bad">' + esc(data.note || '没有找到') + '</span>' +
        (data.missing && data.missing.length ? ' <span class="muted">未命中：' + data.missing.map((id) => esc(id)).join(', ') + '</span>' : '');
      return;
    }
    box.innerHTML = '<div style="margin-bottom:4px">找到 ' + matches.length + ' 个' +
      (data.missing && data.missing.length ? '（未命中 ' + data.missing.length + ' 个）' : '') + '：</div>' +
      matches.map((match, index) =>
        '<div class="srow">' +
          '<span class="badge kind-' + esc(match.kind) + '">' + (match.kind === 'campaign' ? '组' : '素材') + '</span>' +
          '<span class="stext">' + esc(match.storeName) + ' › ' + esc(match.campaignName) + (match.itemId ? ' › ' + esc(String(match.itemId)) : '') + '</span>' +
          '<span class="muted">' + money(match.cost) + ' / ' + num(match.orders) + ' 单</span>' +
          '<button class="act" data-use-match="' + index + '">选用</button>' +
        '</div>').join('');
    for (const button of box.querySelectorAll('[data-use-match]')) {
      button.addEventListener('click', () => applySearchMatch(matches[Number(button.dataset.useMatch)]));
    }
  } catch (error) {
    box.innerHTML = '<span class="bad">搜索失败：' + esc(error.message) + '</span>';
  }
}

async function applySearchMatch(match) {
  const accountSelect = $('#dlgAccount');
  accountSelect.value = match.advertiserId;
  board.pick.advertiserId = match.advertiserId;
  board.pick.items = new Set(match.kind === 'items' ? [match.itemId] : []);
  board.pick.campaignId = match.campaignId || '';
  await loadDlgCampaigns();
  $('#dlgCampaign').value = match.campaignId || '';
  board.pick.campaignId = match.campaignId || '';
  await loadDlgItems();
  $('#dlgNote').value = match.kind === 'items'
    ? '素材 ' + String(match.itemId).slice(-8) + '（' + match.campaignName + '）'
    : '广告组 ' + match.campaignName;
  $('#dlgStatus').textContent = match.kind === 'items'
    ? '已定位素材 ' + String(match.itemId).slice(-8) + '，点「添加到看板」即可'
    : '已定位广告组「' + match.campaignName + '」，点「添加到看板」即可';
}

async function submitAddModule() {
  const advertiserId = $('#dlgAccount').value;
  const campaignId = $('#dlgCampaign').value;
  const account = state.accounts.find((candidate) => candidate.advertiserId === advertiserId) || {};
  const campaignSelect = $('#dlgCampaign');
  const payload = {
    kind: campaignId ? (board.pick.items.size ? 'items' : 'campaign') : 'account',
    advertiserId,
    storeName: account.storeName || '',
    accountName: account.advertiserName || '',
    campaignId,
    campaignName: campaignId ? (campaignSelect.options[campaignSelect.selectedIndex]?.text || '').split(' · ')[0] : '',
    itemIds: board.pick.items.size ? Array.from(board.pick.items) : [],
    note: $('#dlgNote').value.trim(),
    leftMetric: $('#dlgLeft').value,
    width: 'full',
  };
  try {
    const created = await api('/api/board/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    $('#dlg').removeAttribute('open');
    // 立刻插入骨架卡，用户马上看到反馈
    board.data = [...board.data, {
      module: created,
      label: created.label,
      loading: true,
      series: [],
      totals: { cost: 0, orders: 0, revenue: 0, roi: 0, costPerOrder: 0 },
      live: { deltaCost: null, deltaOrders: null, perHour: null, currentHourCost: 0, currentHourOrders: 0 },
    }];
    board.modules = board.data.map((entry) => entry.module).filter(Boolean);
    renderBoardCards();
    refreshBoard({ silent: true });
  } catch (error) {
    $('#dlgStatus').textContent = '添加失败：' + error.message;
  }
}

function bindBoardControls() {
  $('#btnAddModule').addEventListener('click', () => openAddModule(null));
  $('#btnRefreshBoard').addEventListener('click', refreshBoard);
  $('#btnExportBoard').addEventListener('click', exportBoardCsv);
  for (const chip of document.querySelectorAll('#boardInterval .chip')) {
    chip.addEventListener('click', () => {
      const seconds = Number(chip.dataset.interval) || 60;
      localStorage.setItem('tiktok-ads-board-interval', String(seconds));
      for (const other of document.querySelectorAll('#boardInterval .chip')) other.setAttribute('aria-pressed', String(other === chip));
      restartBoardTimer();
      boardCountdown && clearInterval(boardCountdown);
      setIntervalBoardCountdown();
    });
  }
  $('#dlgAccount').addEventListener('change', loadDlgCampaigns);
  $('#dlgSearchGo').addEventListener('click', () => runSearch(false));
  $('#dlgSearchRebuild').addEventListener('click', () => runSearch(true));
  $('#dlgSearch').addEventListener('keydown', (event) => { if (event.key === 'Enter') runSearch(false); });
  $('#dlgCampaign').addEventListener('change', loadDlgItems);
  $('#dlgCancel').addEventListener('click', () => $('#dlg').removeAttribute('open'));
  $('#dlgAdd').addEventListener('click', submitAddModule);
  $('#dlg').addEventListener('click', (event) => { if (event.target === $('#dlg')) $('#dlg').removeAttribute('open'); });
}

/* ---------------- 广告组 ---------------- */
async function renderCampaigns() {
  const data = await api('/api/campaigns?' + rangeQuery() + '&accounts=' + encodeURIComponent(accountQuery()));
  $('#campaignCount').textContent = '共 ' + data.rows.length + ' 个（按消耗排序）';
  if (!data.rows.length) { $('#campaignTable').innerHTML = '<div class="empty">当前范围没有消耗</div>'; $('#drillCard').hidden = true; return; }
  if (!data.rows.length) { /* noop */ }
  $('#campaignTable').innerHTML = '<table><thead><tr><th>账户</th><th>广告组</th><th class="num">消耗</th><th class="num">订单</th><th class="num">GMV</th><th class="num">ROI</th><th class="num">单均</th><th>趋势</th><th>操作</th></tr></thead><tbody>' +
    data.rows.map((row, index) => '<tr class="click" data-idx="' + index + '"><td>' + esc(row.accountName) + '</td><td title="' + esc(row.name) + '">' + esc(row.name) +
      '</td><td class="num">' + money(row.cost) + '</td><td class="num">' + num(row.orders) + '</td><td class="num">' + money(row.revenue) +
      '</td><td class="num ' + roiClass(row.roi) + '">' + row.roi + '</td><td class="num">' + money(row.costPerOrder) + '</td><td>' + sparkline(row.series, 'cost') + '</td><td><button class="act" data-history="' + index + '">历史</button> <button class="act" data-watch-campaign="' + index + '">盯盘</button></td></tr>').join('') +
    '</tbody></table>';
  for (const tr of document.querySelectorAll('[data-idx]')) {
    tr.addEventListener('click', (event) => {
      if (event.target.closest('[data-watch-campaign]')) return;
      drillInto(data.rows[Number(tr.dataset.idx)]);
    });
  }
  for (const button of document.querySelectorAll('[data-history]')) {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const row = data.rows[Number(button.dataset.history)];
      openModal({ kind: 'campaign', advertiserId: row.advertiserId, campaignId: row.campaignId, name: row.name, days: state.days });
    });
  }
  for (const button of document.querySelectorAll('[data-watch-campaign]')) {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const row = data.rows[Number(button.dataset.watchCampaign)];
      openAddModule({ advertiserId: row.advertiserId, campaignId: row.campaignId });
    });
  }
  if (state.pendingDrill) {
    const target = data.rows.find((row) => row.advertiserId === state.pendingDrill.advertiserId && row.campaignId === state.pendingDrill.campaignId);
    state.pendingDrill = null;
    if (target) drillInto(target, true);
  }
  if (state.drill) drillInto(state.drill, true);
}

async function drillInto(row, silent) {
  state.drill = row;
  if (!silent) $('#drillCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#drillCard').hidden = false;
  $('#drillTitle').innerHTML = '下钻：' + esc(row.name) + ' <span class="muted">' + esc(row.accountName) + ' · 消耗 ' + money(row.cost) + ' · ROI ' + row.roi + '（点 SKU / 素材 看涨幅）</span>';
  $('#drillSku').innerHTML = spinnerHtml('加载 SKU…');
  $('#drillCreative').innerHTML = spinnerHtml('加载素材…');
  try {
    const data = await api('/api/campaign-detail?' + rangeQuery() + '&advertiser=' + encodeURIComponent(row.advertiserId) + '&campaign=' + encodeURIComponent(row.campaignId));
    const skuTotal = data.skus.reduce((sum, sku) => sum + sku.cost, 0);
    $('#drillSku').innerHTML = data.skus.length ? '<table><thead><tr><th>SKU</th><th class="num">消耗</th><th class="num">占比</th><th class="num">订单</th><th class="num">ROI</th></tr></thead><tbody>' +
      data.skus.map((sku) => '<tr class="click" data-spu="' + esc(sku.spu) + '" title="' + esc(sku.name || sku.spu) + '"><td>' + esc(sku.sku || String(sku.spu).slice(-6)) +
        '</td><td class="num">' + money(sku.cost) + '</td><td class="num muted">' + (skuTotal > 0 ? Math.round((sku.cost / skuTotal) * 100) : 0) + '%' +
        '</td><td class="num">' + num(sku.orders) + '</td><td class="num ' + roiClass(sku.roi) + '">' + sku.roi + '</td></tr>').join('') +
      '</tbody></table>' : '<div class="empty">该组没有商品消耗</div>';
    state.drillCreatives = data.creatives || [];
    state.drill = row;
    renderCreativeTable(row);
    for (const tr of document.querySelectorAll('[data-spu]')) {
      tr.addEventListener('click', () => {
        const sku = data.skus.find((entry) => entry.spu === tr.dataset.spu);
        openModal({ kind: 'sku', advertiserId: row.advertiserId, campaignId: row.campaignId, spu: sku.spu, name: ((sku.sku || '') + ' ' + (sku.name || '')).trim() || ('商品 ' + sku.spu), days: state.days });
      });
    }
  } catch (error) {
    $('#drillSku').innerHTML = '<div class="empty">加载失败：' + esc(error.message) + '</div>';
    $('#drillCreative').innerHTML = '';
  }
}

/* 素材表：支持按列排序 + 状态筛选（点击行看历史曲线） */
function renderCreativeTable(row) {
  const container = $('#drillCreative');
  const list = state.drillCreatives || [];
  if (!list.length) {
    container.innerHTML = '<div class="empty">该组没有素材消耗</div>';
    return;
  }
  const query = (state.drillSearch || '').trim();
  const filteredBase = query ? list.filter((creative) => String(creative.itemId).includes(query)) : list;
  const counts = { all: filteredBase.length, kill: 0, watch: 0, scale: 0, normal: 0 };
  for (const creative of filteredBase) counts[creative.status || 'normal'] += 1;
  const chips = [['all', '全部'], ['kill', '待删'], ['scale', '加热'], ['watch', '观察'], ['normal', '正常']]
    .map(([key, label]) => '<button class="chip" data-status="' + key + '" aria-pressed="' + (state.drillStatus === key) + '">' + label + ' <span class="muted">' + (counts[key] || 0) + '</span></button>')
    .join('');
  const filtered = filteredBase.filter((creative) => state.drillStatus === 'all' || (creative.status || 'normal') === state.drillStatus)
    .sort((left, right) => {
      const { field, dir } = state.drillSort;
      const leftValue = field === 'status' ? String(left.status || 'normal') : Number(left[field]) || 0;
      const rightValue = field === 'status' ? String(right.status || 'normal') : Number(right[field]) || 0;
      const compare = leftValue > rightValue ? 1 : leftValue < rightValue ? -1 : 0;
      return compare * (dir === 'asc' ? 1 : -1);
    });
  const arrow = (field) => (state.drillSort.field === field ? (state.drillSort.dir === 'asc' ? ' ↑' : ' ↓') : '');
  const th = (field, label, numeric) => '<th class="sortable' + (numeric ? ' num' : '') + '" data-sort="' + field + '">' + label + arrow(field) + '</th>';
  container.innerHTML =
    '<div class="drillTools"><div class="chips">' + chips + '</div>' +
    '<span class="muted">点任意素材行 → 看历史曲线（可自定义时间）</span></div>' +
    '<table><thead><tr>' +
    th('status', '状态', false) + '<th>作品ID</th><th>SKU</th>' + th('cost', '消耗', true) + th('orders', '订单', true) + th('roi', 'ROI', true) + th('ctr', 'CTR', true) + '<th>操作</th>' +
    '</tr></thead><tbody>' +
    (filtered.length ? filtered.map((creative) => {
      const meta = STATUS_META[creative.status] || STATUS_META.normal;
      return '<tr class="click" data-item="' + esc(creative.itemId) + '">' +
        '<td><span class="' + (meta.cls || '') + '">' + meta.label + '</span></td>' +
        '<td><span class="pid" data-copy-item="' + esc(creative.itemId) + '" title="点击复制作品ID">' + esc(creative.itemId) + '</span></td>' +
        '<td class="muted" title="' + esc(creative.productName || '') + '">' + esc(creative.sku || '-') + '</td>' +
        '<td class="num">' + money(creative.cost) + '</td><td class="num">' + num(creative.orders) + '</td>' +
        '<td class="num ' + roiClass(creative.roi) + '">' + creative.roi + '</td><td class="num">' + pct(creative.ctr) + '</td>' +
        '<td><button class="act" data-watch-item="' + esc(creative.itemId) + '">盯盘</button> <button class="act" data-copy-item="' + esc(creative.itemId) + '">复制ID</button></td></tr>';
    }).join('') : '<tr><td colspan="8" class="empty">该状态下没有素材</td></tr>') +
    '</tbody></table>';
  void row;
}

/* 素材表事件委托（排序 / 筛选 / 复制 / 盯盘 / 打开历史） */
function bindDrillEvents() {
  const container = $('#drillCreative');
  if (!container || container.dataset.bound) return;
  container.dataset.bound = '1';
  const searchInput = $('#drillSearch');
  if (searchInput && !searchInput.dataset.bound) {
    searchInput.dataset.bound = '1';
    searchInput.addEventListener('input', () => {
      state.drillSearch = searchInput.value;
      renderCreativeTable(state.drill);
    });
  }
  container.addEventListener('click', (event) => {
    const sortTh = event.target.closest('[data-sort]');
    if (sortTh) {
      const field = sortTh.dataset.sort;
      if (state.drillSort.field === field) state.drillSort.dir = state.drillSort.dir === 'asc' ? 'desc' : 'asc';
      else state.drillSort = { field, dir: field === 'status' ? 'asc' : 'desc' };
      renderCreativeTable(state.drill);
      return;
    }
    const statusChip = event.target.closest('[data-status]');
    if (statusChip) {
      state.drillStatus = statusChip.dataset.status;
      renderCreativeTable(state.drill);
      return;
    }
    const copyTarget = event.target.closest('[data-copy-item]');
    if (copyTarget) {
      event.stopPropagation();
      copyText(copyTarget.dataset.copyItem);
      return;
    }
    const watchButton = event.target.closest('[data-watch-item]');
    if (watchButton) {
      event.stopPropagation();
      if (state.drill) openAddModule({ advertiserId: state.drill.advertiserId, campaignId: state.drill.campaignId, itemId: watchButton.dataset.watchItem });
      return;
    }
    const tr = event.target.closest('tr[data-item]');
    if (tr && state.drill) {
      openModal({
        kind: 'creative',
        advertiserId: state.drill.advertiserId,
        campaignId: state.drill.campaignId,
        itemId: tr.dataset.item,
        name: '素材 ' + String(tr.dataset.item).slice(-8),
        days: state.days,
      });
    }
  });
}

/* ---------------- 详情弹窗 ---------------- */
async function openModal(params) {
  state.modal = { ...params, days: params.days || state.days, metric: 'cost', custom: params.custom || null };
  const modalCustom = $('#modalCustomRange');
  if (modalCustom) modalCustom.hidden = !state.modal.custom;
  if (state.modal.custom) {
    $('#modalStart').value = state.modal.custom.start;
    $('#modalEnd').value = state.modal.custom.end;
  }
  $('#modal').setAttribute('open', 'true');
  $('#modalTitle').textContent = params.name || '详情';
  $('#modalMeta').textContent = params.kind === 'account' ? '账户趋势' : params.kind === 'sku' ? 'SKU 趋势' : '素材趋势';
  for (const el of document.querySelectorAll('#modalRangeChips .chip')) el.setAttribute('aria-pressed', String(Number(el.dataset.days) === state.modal.days));
  for (const el of document.querySelectorAll('#modalMetricChips .chip')) el.setAttribute('aria-pressed', String(el.dataset.metric === 'cost'));
  await renderModal();
}
async function renderModal() {
  const m = state.modal;
  if (!m) return;
  $('#modalChart').innerHTML = spinnerHtml('加载历史曲线…');
  const custom = m.custom || (state.custom && state.custom.start && state.custom.end ? state.custom : null);
  const query = '/api/trend?days=' + (custom ? m.days : m.days) + (custom ? '&start=' + encodeURIComponent(custom.start) + '&end=' + encodeURIComponent(custom.end) : '') + '&advertiser=' + encodeURIComponent(m.advertiserId) +
    (m.campaignId ? '&campaign=' + encodeURIComponent(m.campaignId) : '') +
    (m.spu ? '&spu=' + encodeURIComponent(m.spu) : '') + (m.itemId ? '&item=' + encodeURIComponent(m.itemId) : '');
  try {
    const data = await api(query);
    const series = data.series || [];
    const sums = series.reduce((acc, point) => ({ cost: acc.cost + point.cost, orders: acc.orders + point.orders, revenue: acc.revenue + point.revenue }), { cost: 0, orders: 0, revenue: 0 });
    $('#modalKpis').innerHTML = [
      ['消耗', money(sums.cost)], ['订单', num(sums.orders)], ['GMV', money(sums.revenue)],
      ['ROI', '<span class="' + roiClass(sums.cost > 0 ? sums.revenue / sums.cost : 0) + '">' + (sums.cost > 0 ? (sums.revenue / sums.cost).toFixed(2) : '0') + '</span>'],
    ].map(([k, v]) => '<div class="kpi"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>').join('');
    $('#modalChart').innerHTML = lineChart([{ name: m.name || '', color: PALETTE[0], points: series }], m.metric, { width: 900, height: 300 });
    bindChartTip($('#modalChart'), series, [m.metric, 'cost', 'orders', 'revenue'].filter((metric, index, list) => list.indexOf(metric) === index));
    const values = series.map((point) => Number(point[m.metric]) || 0);
    const first = values[0] || 0, last = values[values.length - 1] || 0;
    const trend = first > 0 ? ((last - first) / first) * 100 : 0;
    $('#modalMeta').textContent = (data.range ? data.range.start + ' ~ ' + data.range.end : '') + ' · 首日→末日 ' + (trend >= 0 ? '+' : '') + trend.toFixed(1) + '%';
  } catch (error) {
    $('#modalChart').innerHTML = '<div class="empty">加载失败：' + esc(error.message) + '</div>';
  }
}

/* ---------------- 历史整日对比 ---------------- */
/** 对比指标 = 今日主指标（KPI 里勾选的第一个） */
function primaryMetric(module) {
  const metrics = (module && module.metrics) || [];
  const first = metrics.find((metric) => METRIC_META[metric]);
  return first || (module && module.leftMetric === 'revenue' ? 'revenue' : 'cost');
}
function primaryMetricLabel(module) {
  const metric = primaryMetric(module);
  return (METRIC_META[metric] && METRIC_META[metric].label) || metric;
}
async function loadCompare(moduleId) {
  const node = document.querySelector('[data-compare-wrap="' + moduleId + '"]');
  if (!node) return;
  const module = (board.modules || []).find((item) => item.id === moduleId) || {};
  const date = module.compare === 'date' && module.compareDate ? module.compareDate : '';
  try {
    const data = await api('/api/board/compare?module=' + encodeURIComponent(moduleId) + (date ? '&date=' + encodeURIComponent(date) : ''));
    if (!data || !data.ok) {
      node.innerHTML = '<div class="empty">对比数据不可用</div>';
      return;
    }
    const metric = primaryMetric(module);
    node.innerHTML = compareSummaryHtml(data, metric) + compareChart(data, metric);
    bindCompareTip(node, data);
  } catch (error) {
    node.innerHTML = '<div class="empty">对比加载失败：' + esc(error.message) + '</div>';
  }
}

function pctChange(current, previous) {
  if (!previous) return current > 0 ? '+100%' : '—';
  const delta = ((current - previous) / previous) * 100;
  return (delta >= 0 ? '+' : '') + delta.toFixed(1) + '%';
}

function compareSummaryHtml(data, metric) {
  const cur = data.current.totals || {};
  const prev = data.compare.totals || {};
  const key = metric === 'revenue' ? 'revenue' : metric === 'orders' ? 'orders' : 'cost';
  const isMoney = key !== 'orders';
  const label = (METRIC_META[key] && METRIC_META[key].label) || key;
  const a = isMoney ? money(cur[key]) : num(cur[key]);
  const b = isMoney ? money(prev[key]) : num(prev[key]);
  const change = pctChange(Number(cur[key]) || 0, Number(prev[key]) || 0);
  const cls = String(change).startsWith('-') ? 'cmpDown' : 'cmpUp';
  return '<div class="cmpSummary">' +
    '<span class="muted">' + esc(data.current.date) + ' vs ' + esc(data.compare.date) + '</span>' +
    '<span>' + esc(label) + ' <b>' + a + '</b> <span class="' + cls + '">' + change + '</span>' +
    '<span class="muted"> vs ' + b + '</span></span>' +
    '</div>';
}

/** 两条小时曲线：今日（实线）vs 对比日（虚线） */
function compareChart(data, metricInput) {
  const width = 760, height = 240;
  const pad = { left: 54, right: 18, top: 14, bottom: 26 };
  const innerW = width - pad.left - pad.right, innerH = height - pad.top - pad.bottom;
  const metric = METRIC_META[metricInput] ? metricInput : 'cost';
  const valueOf = (point) => Number(point[metric]) || 0;
  const all = [data.current.points || [], data.compare.points || []].flat().map(valueOf);
  const maxV = Math.max(1, ...all) * 1.15;
  const x = (index) => pad.left + (index / 23) * innerW;
  const y = (value) => pad.top + innerH - (value / maxV) * innerH;
  const moneyMetric = metric === 'cost' || metric === 'revenue';
  let svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" height="' + height + '" data-w="' + width + '" data-pl="' + pad.left + '" data-pr="' + pad.right + '">';
  for (let i = 0; i <= 4; i += 1) {
    const gy = pad.top + (innerH / 4) * i;
    svg += '<line x1="' + pad.left + '" x2="' + (width - pad.right) + '" y1="' + gy + '" y2="' + gy + '" stroke="#242a3a"/>';
    svg += '<text x="' + (pad.left - 10) + '" y="' + (gy + 4) + '" fill="#8f97a8" font-size="10.5" text-anchor="end">' +
      (moneyMetric ? '$' + Math.round(maxV * (1 - i / 4)) : Math.round(maxV * (1 - i / 4))) + '</text>';
  }
  for (let hour = 0; hour < 24; hour += 3) {
    svg += '<text x="' + x(hour) + '" y="' + (height - 8) + '" fill="#8f97a8" font-size="10.5" text-anchor="middle">' +
      (String(hour).padStart(2, '0') + ':00') + '</text>';
  }
  const draw = (points, color, dashed, name) => {
    let path = '';
    points.forEach((point, index) => {
      path += (path ? ' L' : 'M') + x(index).toFixed(1) + ' ' + y(valueOf(point)).toFixed(1);
    });
    svg += '<path d="' + path + '" fill="none" stroke="' + color + '" stroke-width="2"' + (dashed ? ' stroke-dasharray="4 3"' : '') + ' stroke-linejoin="round"/>';
    points.forEach((point, index) => {
      svg += '<circle cx="' + x(index) + '" cy="' + y(valueOf(point)) + '" r="2.4" fill="' + color + '" data-cmp-tip="' +
        esc(point.hour + ' · ' + name + ' · ' + (moneyMetric ? money(valueOf(point)) : valueOf(point))) + '"/>';
    });
  };
  draw(data.compare.points || [], '#8f97a8', true, data.compare.date);
  draw(data.current.points || [], '#4f7cff', false, data.current.date);
  svg += '</svg>';
  const legend = '<div class="cmpSummary"><span><i style="display:inline-block;width:14px;height:3px;background:#4f7cff;vertical-align:middle"></i> ' +
    esc(data.current.date) + '（今日）</span><span><i style="display:inline-block;width:14px;height:3px;background:#8f97a8;vertical-align:middle"></i> ' +
    esc(data.compare.date) + '（对比）</span></div>';
  return legend + svg;
}

function bindCompareTip(node, data) {
  const wrap = node.querySelector('.chartwrap') || node;
  void data;
  void wrap;
}

/* ---------------- 卡片内「素材实时」 ---------------- */
function creativeRowsForModule(module) {
  const boardRows = (state.creativeBoard && state.creativeBoard.rows) || [];
  if (!module) return [];
  return boardRows.filter((row) => {
    if (module.itemIds && module.itemIds.length) return module.itemIds.map(String).includes(String(row.itemId));
    if (module.campaignId) return String(row.advertiserId) === String(module.advertiserId);
    return String(row.advertiserId) === String(module.advertiserId);
  }).slice(0, 80);
}

const STATUS_LABEL = { kill: '待删', watch: '观察', scale: '加热', normal: '正常' };

function creativeTableHtml(rows) {
  if (!state.creativeBoard) return spinnerHtml('素材数据加载中…');
  if (!rows.length) return '<div class="empty">今天还没有素材消耗</div>';
  return '<table><thead><tr><th></th><th>状态</th><th>作品ID</th><th>SKU</th><th class="num">消耗</th><th class="num">订单</th><th class="num">ROI</th><th class="num">点击</th></tr></thead><tbody>' +
    rows.map((row) =>
      '<tr><td><button class="favBtn ' + (row.favorite ? 'on' : '') + '" data-fav-item="' + esc(row.itemId) + '" title="收藏并置顶">' + (row.favorite ? '★' : '☆') + '</button></td>' +
      '<td><span class="st-' + esc(row.status) + '">' + (STATUS_LABEL[row.status] || '正常') + '</span></td>' +
      '<td><span class="pid" data-copy-item="' + esc(row.itemId) + '" title="点击复制：' + esc(row.itemId) + '">' + esc(row.itemId) + '</span></td>' +
      '<td class="muted">' + esc(row.sku || '-') + '</td>' +
      '<td class="num">' + money(row.cost) + '</td>' +
      '<td class="num">' + num(row.orders) + '</td>' +
      '<td class="num ' + roiClass(row.roi) + '">' + row.roi + '</td>' +
      '<td class="num muted">' + num(row.clicks) + '</td></tr>').join('') +
    '</tbody></table>';
}

async function toggleFavorite(itemId, button) {
  const next = !button.classList.contains('on');
  button.classList.toggle('on', next);
  button.textContent = next ? '★' : '☆';
  const boardRows = (state.creativeBoard && state.creativeBoard.rows) || [];
  const row = boardRows.find((candidate) => String(candidate.itemId) === String(itemId));
  if (row) row.favorite = next;
  boardRows.sort((left, right) => {
    if (left.favorite !== right.favorite) return left.favorite ? -1 : 1;
    return right.cost - left.cost;
  });
  const container = button.closest('.cardItems');
  if (container) {
    const moduleId = container.dataset.cardItems;
    const module = (board.modules || []).find((candidate) => candidate.id === moduleId);
    container.innerHTML = creativeTableHtml(creativeRowsForModule(module));
    bindCreativeCellEvents(container);
  }
  try {
    await api('/api/creative', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId, favorite: next }),
    });
  } catch (error) {
    console.warn('收藏失败', error);
  }
}

function bindCreativeCellEvents(root) {
  for (const button of root.querySelectorAll('[data-fav-item]')) {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleFavorite(button.dataset.favItem, button);
    });
  }
  for (const node of root.querySelectorAll('[data-copy-item]')) {
    node.addEventListener('click', () => copyText(node.dataset.copyItem));
  }
}
function enqueueCardItems(moduleId) {
  if (!state.cardQueue) state.cardQueue = [];
  if (state.cardQueue.includes(moduleId)) return;
  state.cardQueue.push(moduleId);
  drainCardQueue();
}

async function drainCardQueue() {
  if (state.cardBusy) return;
  state.cardBusy = true;
  try {
    while (state.cardQueue.length) {
      const moduleId = state.cardQueue.shift();
      await loadCardItems(moduleId);
    }
  } finally {
    state.cardBusy = false;
  }
}
async function loadCardItems(moduleId) {
  const node = document.querySelector('[data-card-items="' + moduleId + '"]');
  if (!node) return;
  try {
    const data = await api('/api/board/expanded?module=' + encodeURIComponent(moduleId) + '&mode=none');
    const rows = (data.rows || []).slice(0, 30);
    node.innerHTML = rows.length
      ? '<table><thead><tr><th></th><th>作品ID</th><th class="num">消耗</th><th class="num">订单</th><th class="num">ROI</th></tr></thead><tbody>' +
        rows.map((row) =>
          '<tr><td><button class="favBtn ' + (row.favorite ? 'on' : '') + '" data-card-fav="' + esc(row.itemId) + '">' + (row.favorite ? '★' : '☆') + '</button></td>' +
          '<td><span class="pid" data-copy-item="' + esc(row.itemId) + '">' + esc(row.itemId) + '</span></td>' +
          '<td class="num">' + money(row.cost) + '</td><td class="num">' + num(row.orders) + '</td>' +
          '<td class="num ' + roiClass(row.roi) + '">' + row.roi + '</td></tr>').join('') +
        '</tbody></table>'
      : '<div class="empty">今天还没有素材消耗</div>';
    for (const button of node.querySelectorAll('[data-card-fav]')) {
      button.addEventListener('click', async (event) => {
        event.stopPropagation();
        const itemId = button.dataset.cardFav;
        await api('/api/board/creative', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ moduleId, itemId, favorite: !button.classList.contains('on') }),
        });
        node.dataset.loaded = '';
        loadCardItems(moduleId);
      });
    }
    for (const pid of node.querySelectorAll('[data-copy-item]')) {
      pid.addEventListener('click', () => copyText(pid.dataset.copyItem));
    }
  } catch (error) {
    node.innerHTML = '<div class="empty">加载失败：' + esc(error.message) + '</div>';
  }
}

/* ---------------- 盯盘卡片展开：素材实时 + 收藏 + 备注 + 对比 ---------------- */
async function openExpandModal(moduleId) {
  state.expandModuleId = moduleId;
  const entry = (board.data || []).find((item) => item.module && item.module.id === moduleId);
  $('#expandTitle').textContent = '素材实时明细 · ' + ((entry && entry.label) || '');
  $('#expandMeta').textContent = '收藏置顶 · 可备注 · 可对比历史/均值';
  $('#expandModal').setAttribute('open', 'true');
  await loadExpanded(moduleId);
}

async function loadExpanded(moduleId) {
  const box = $('#expandBody');
  if (!box) return;
  state.expandedCompare = state.expandedCompare || {};
  const compare = state.expandedCompare[moduleId] || { mode: 'none', days: 7 };
  box.innerHTML = spinnerHtml('拉取素材明细…');
  const dateValue = compare.date || '';
  try {
    const query = '/api/board/expanded?module=' + encodeURIComponent(moduleId) +
      '&mode=' + encodeURIComponent(compare.mode || 'none') +
      '&days=' + encodeURIComponent(compare.days || 7) +
      (dateValue ? '&date=' + encodeURIComponent(dateValue) : '');
    const data = await api(query);
    const rows = data.rows || [];
    const baselineLabel = data.compare && data.compare.mode === 'avg'
      ? '近 ' + data.compare.days + ' 天均值（' + data.compare.start + ' ~ ' + data.compare.end + '）'
      : data.compare && data.compare.mode === 'day'
        ? data.compare.start
        : '不对比';
    box.innerHTML =
      '<div class="expandedTools">' +
        '<span>对比基线</span>' +
        '<select data-compare-mode="' + esc(moduleId) + '">' +
          '<option value="none"' + (compare.mode === 'none' ? ' selected' : '') + '>不对比</option>' +
          '<option value="avg"' + (compare.mode === 'avg' ? ' selected' : '') + '>近 N 天均值</option>' +
          '<option value="day"' + (compare.mode === 'day' ? ' selected' : '') + '>指定日期</option>' +
        '</select>' +
        '<select data-compare-days="' + esc(moduleId) + '">' + [3, 7, 14, 30].map((days) => '<option value="' + days + '"' + (Number(compare.days) === days ? ' selected' : '') + '>' + days + ' 天</option>').join('') + '</select>' +
        '<input type="date" data-compare-date="' + esc(moduleId) + '" value="' + esc(dateValue) + '"' + (compare.mode === 'day' ? '' : ' hidden') + '>' +
        '<span class="muted">' + esc(baselineLabel) + ' · ' + rows.length + ' 条素材</span>' +
      '</div>' +
      (rows.length
        ? '<div class="expandedTable"><table><thead><tr><th></th><th>作品ID</th><th class="num">今日消耗</th><th class="num">订单</th><th class="num">ROI</th><th class="num">对比</th><th>备注</th></tr></thead><tbody>' +
          rows.map((row) =>
            '<tr data-creative-row="' + esc(row.itemId) + '">' +
            '<td><button class="favBtn ' + (row.favorite ? 'on' : '') + '" data-fav="' + esc(row.itemId) + '" title="收藏并置顶">' + (row.favorite ? '★' : '☆') + '</button></td>' +
            '<td><span class="pid" data-copy-item="' + esc(row.itemId) + '" title="点击复制作品ID">' + esc(row.itemId) + '</span></td>' +
            '<td class="num">' + money(row.cost) + '</td><td class="num">' + num(row.orders) + '</td>' +
            '<td class="num ' + roiClass(row.roi) + '">' + row.roi + '</td>' +
            '<td class="num">' + (row.baselineCost === null ? '<span class="muted">—</span>' :
              '<span class="' + (row.deltaCost > 0 ? 'bad' : row.deltaCost < 0 ? 'good' : 'muted') + '">' +
              (row.deltaCost > 0 ? '+' : '') + money(row.deltaCost) + '</span> <span class="muted">vs ' + money(row.baselineCost) + '</span>') + '</td>' +
            '<td><input class="rowNote" data-note="' + esc(row.itemId) + '" value="' + esc(row.note || '') + '" placeholder="备注…"></td>' +
            '</tr>').join('') +
          '</tbody></table></div>'
        : '<div class="empty">今天还没有素材消耗</div>');
    bindExpandedControls(moduleId);
  } catch (error) {
    box.innerHTML = '<div class="empty">加载失败：' + esc(error.message) + '</div>';
  }
}

function bindExpandedControls(moduleId) {
  const box = $('#expandBody');
  if (!box) return;
  state.expandedCompare = state.expandedCompare || {};
  const current = state.expandedCompare[moduleId] || { mode: 'none', days: 7 };
  const modeSelect = box.querySelector('[data-compare-mode]');
  if (modeSelect) modeSelect.addEventListener('change', () => {
    current.mode = modeSelect.value;
    state.expandedCompare[moduleId] = current;
    loadExpanded(moduleId);
  });
  const daysSelect = box.querySelector('[data-compare-days]');
  if (daysSelect) daysSelect.addEventListener('change', () => {
    current.days = Number(daysSelect.value) || 7;
    state.expandedCompare[moduleId] = current;
    loadExpanded(moduleId);
  });
  const dateInput = box.querySelector('[data-compare-date]');
  if (dateInput) {
    dateInput.addEventListener('change', () => {
      current.date = dateInput.value;
      if (current.mode !== 'day') { current.mode = 'day'; }
      state.expandedCompare[moduleId] = current;
      loadExpanded(moduleId);
    });
  }
  for (const button of box.querySelectorAll('[data-fav]')) {
    button.addEventListener('click', async () => {
      const itemId = button.dataset.fav;
      const nowFavorite = !button.classList.contains('on');
      await api('/api/board/creative', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ moduleId, itemId, favorite: nowFavorite }),
      });
      loadExpanded(moduleId);
    });
  }
  for (const input of box.querySelectorAll('[data-note]')) {
    input.addEventListener('blur', async () => {
      await api('/api/board/creative', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ moduleId, itemId: input.dataset.note, note: input.value }),
      });
    });
  }
  for (const node of box.querySelectorAll('[data-copy-item]')) {
    node.addEventListener('click', () => copyText(node.dataset.copyItem));
  }
}

/* ---------------- 商品信息 ---------------- */
async function renderProducts() {
  const status = await api('/api/products');
  const meta = $('#prodMeta');
  if (status.hasData) {
    meta.innerHTML = '已导入 <b>' + status.count + '</b> 个商品（' + esc(status.fileName || '') + '，区域 ' + esc(status.region || '') +
      '，' + new Date(status.importedAt).toLocaleString('zh-CN') + '）';
  } else {
    meta.textContent = '还没有导入商品，先按上面步骤导出并上传。';
  }
  $('#prodJoinHint').textContent = '· 按 SPU 合并广告消耗/订单（区间 ' + (state.custom ? state.custom.start + '~' + state.custom.end : state.days + ' 天') + '）';
  $('#prodTable').innerHTML = spinnerHtml('合并广告数据…');
  try {
    const joined = await api('/api/products/join?' + rangeQuery() + '&accounts=' + encodeURIComponent(accountQuery()));
    if (!joined.ok) {
      $('#prodTable').innerHTML = '<div class="empty">' + esc(joined.error || '没有商品数据') + '</div>';
      return;
    }
    state.products = joined.products || [];
    renderProductRows();
  } catch (error) {
    $('#prodTable').innerHTML = '<div class="empty">加载失败：' + esc(error.message) + '</div>';
  }
}

function renderProductRows() {
  const keyword = ($('#prodSearch').value || '').trim().toLowerCase();
  const rows = (state.products || []).filter((row) => !keyword ||
    String(row.sellerSku || '').toLowerCase().includes(keyword) ||
    String(row.name || '').toLowerCase().includes(keyword));
  $('#prodTable').innerHTML = rows.length
    ? '<table><thead><tr><th>商品</th><th>商家SKU</th><th class="num">价格</th><th>状态</th><th class="num">广告消耗</th><th class="num">订单</th><th class="num">GMV</th><th class="num">ROI</th></tr></thead><tbody>' +
      rows.slice(0, 400).map((row) =>
        '<tr><td title="' + esc(row.name) + '">' + esc((row.name || '').slice(0, 46)) + '</td>' +
        '<td>' + esc(row.sellerSku || '-') + '</td><td class="num">' + esc(row.price || '-') +
        '</td><td class="muted">' + esc(row.status || '-') + '</td>' +
        '<td class="num">' + money(row.cost) + '</td><td class="num">' + num(row.orders) + '</td>' +
        '<td class="num">' + money(row.revenue) + '</td>' +
        '<td class="num ' + roiClass(row.roi) + '">' + (row.roi || 0) + '</td></tr>').join('') +
      '</tbody></table>'
    : '<div class="empty">没有匹配的商品</div>';
}

async function uploadProducts() {
  const input = $('#prodFile');
  const file = input.files && input.files[0];
  if (!file) { $('#prodStatus').textContent = '先选择一个 xlsx / csv 文件'; return; }
  $('#prodStatus').innerHTML = '<span class="spinner"></span>导入解析中…';
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  try {
    const result = await api('/api/products/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64, fileName: file.name, region: $('#prodRegion').value }),
    });
    if (!result.ok) {
      $('#prodStatus').textContent = '导入失败：' + (result.error || '未知错误');
      return;
    }
    $('#prodStatus').textContent = '导入成功：' + result.count + ' 个商品（含 product_id ' + result.withProductId + ' 个，SKU ' + result.withSellerSku + ' 个）';
    renderProducts();
  } catch (error) {
    $('#prodStatus').textContent = '导入失败：' + error.message;
  }
}

const PRODUCT_GUIDE = [
  '【卖家中心商品导出步骤】',
  '1. 打开 https://seller.eu.tiktokshopglobalselling.com/product/batch/edit-prods?entry-from=manage&shop_region=GB',
  '2. 选择要导出的店铺（GB/DE/…）',
  '3. 点「导出」或「下载全部信息」，得到 xlsx',
  '4. 在本面板「商品信息 → 选择文件 → 导入」上传',
  '字段要求：product_id（商品 ID）、seller_sku（商家 SKU）必须有，其余（名称/价格/状态）可选。',
].join('\n');

function bindProductControls() {
  const upload = $('#prodUpload');
  if (upload) upload.addEventListener('click', uploadProducts);
  const guide = $('#prodGuide');
  if (guide) guide.addEventListener('click', () => copyText(PRODUCT_GUIDE));
  const search = $('#prodSearch');
  if (search) search.addEventListener('input', () => { if (state.products) renderProductRows(); });
}

/* ---------------- AI 监控投放（规则巡检 + 摘要） ---------------- */
async function renderAI() {
  $('#aiKpis').innerHTML = spinnerHtml('正在巡检…');
  $('#aiConclusions').innerHTML = '';
  $('#aiActions').innerHTML = '';
  $('#aiAlerts').innerHTML = '';
  try {
    const data = await api('/api/inspect?' + rangeQuery() + '&accounts=' + encodeURIComponent(accountQuery()));
    const totals = data.totals || {};
    $('#aiKpis').innerHTML = [
      ['消耗', money(totals.cost)], ['订单', num(totals.orders)], ['GMV', money(totals.revenue)],
      ['ROI', '<span class="' + roiClass(totals.roi) + '">' + totals.roi + '</span>'],
      ['单均', money(totals.costPerOrder)],
    ].map(([k, v]) => '<div class="kpi"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>').join('');
    $('#aiRange').textContent = data.range ? '· ' + data.range.start + ' ~ ' + data.range.end : '';
    $('#aiConclusions').innerHTML = (data.conclusions || []).map((line, index) =>
      '<div class="aiLine"><span class="n">' + (index + 1) + '.</span><span>' + esc(line) + '</span></div>').join('');
    $('#aiActions').innerHTML = (data.actions || []).length
      ? (data.actions || []).map((item) =>
        '<div class="aiLine"><span class="aiTag ' + esc(item.level) + '">' + esc(item.action) + '</span><span>' + esc(item.target) + '</span><span class="muted" style="margin-left:auto">' + esc(item.reason) + '</span></div>').join('')
      : '<div class="empty">当前没有需要处理的动作 👌</div>';
    $('#aiAlerts').innerHTML = (data.boardAlerts || []).length
      ? (data.boardAlerts || []).map((alert) => '<div class="aiLine"><span class="aiTag ' + esc(alert.level === 'critical' ? 'critical' : 'warning') + '">告警</span><span>' + esc(alert.message) + '</span></div>').join('')
      : '<div class="empty">盯盘无告警</div>';
    $('#aiCopy').onclick = async () => {
      await copyText(data.brief || '');
    };
  } catch (error) {
    $('#aiKpis').innerHTML = '';
    $('#aiConclusions').innerHTML = '<div class="empty">巡检失败：' + esc(error.message) + '</div>';
  }
}

/* ---------------- 数据导出 ---------------- */
async function renderExport() {
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (date) => date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  const yesterday = iso(new Date(today.getTime() - 86400000));
  if (!$('#expStart').value) $('#expStart').value = state.custom && state.custom.start ? state.custom.start : yesterday;
  if (!$('#expEnd').value) $('#expEnd').value = state.custom && state.custom.end ? state.custom.end : yesterday;
  $('#expRun').onclick = runExportNow;
  const status = await api('/api/export/status');
  if (status && status.running) {
    $('#expStatus').textContent = '正在导出…';
  }
  if (status && status.files && status.files.length) showExportFiles(status);
}

async function runExportNow() {
  const start = $('#expStart').value;
  const end = $('#expEnd').value;
  if (!start || !end) { alert('请选择开始和结束日期'); return; }
  if (start > end) { alert('开始日期不能晚于结束日期'); return; }
  $('#expStatus').innerHTML = '<span class="spinner"></span>导出中…';
  $('#expResult').innerHTML = '';
  $('#expRun').disabled = true;
  const startedAt = Date.now();
  const poll = setInterval(async () => {
    const status = await api('/api/export/status');
    if (status && status.running) {
      const done = status.progress || 0;
      const total = status.totalDays || 1;
      $('#expStatus').innerHTML = '<span class="spinner"></span>导出中… ' + done + '/' + total + ' 天' +
        (status.currentDate ? '（当前 ' + status.currentDate + '）' : '') + ' · 已用时 ' + Math.round((Date.now() - startedAt) / 1000) + ' 秒';
      return;
    }
    clearInterval(poll);
    $('#expRun').disabled = false;
    if (status && status.error) {
      $('#expStatus').textContent = '导出失败：' + status.error;
    } else {
      $('#expStatus').textContent = '完成，用时 ' + Math.round((Date.now() - startedAt) / 1000) + ' 秒';
    }
    if (status) showExportFiles(status);
  }, 3000);
  await api('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ start, end }) });
}

function showExportFiles(status) {
  const files = status.files || [];
  $('#expResult').innerHTML = files.length
    ? '<div class="muted" style="font-size:12px;margin-bottom:6px">已生成 ' + files.length + ' 个文件 · 保存在：' + esc(status.dir || '') +
        ' <button class="act" id="expCopyDir" style="padding:1px 8px;font-size:11px">复制路径</button></div>' +
      files.map((file) => '<div class="expFile"><span class="n" data-copy-path="' + esc(file.path) + '">' + esc(file.name) + '</span>' +
        '<span class="muted">' + Math.round(file.size / 1024) + ' KB</span>' +
        '<a class="dl" href="/api/export/download?name=' + encodeURIComponent(file.name) + '">下载</a></div>').join('')
    : '<div class="empty">暂无文件</div>';
  for (const node of document.querySelectorAll('[data-copy-path]')) {
    node.addEventListener('click', () => copyText(node.dataset.copyPath));
  const dirButton = $('#expCopyDir');
  if (dirButton) dirButton.addEventListener('click', () => copyText(status.dir || ''));
  }
}

/* ---------------- 诊断（素材赛马场 + SKU 作战室） ---------------- */
async function renderDiagnosis() {
  $('#diagKpis').innerHTML = '';
  $('#diagCreative').innerHTML = spinnerHtml('加载诊断数据…');
  $('#diagSku').innerHTML = '';
  try {
    const data = await api('/api/diagnosis?' + rangeQuery() + '&accounts=' + encodeURIComponent(accountQuery()));
    if (data.loading) {
      $('#diagKpis').innerHTML = '';
      $('#diagCreative').innerHTML = '<div class="empty" style="padding:18px 0">诊断数据还没算过（这块待开发，口径未校准）。<br>' +
        '<span class="muted" style="font-size:11.5px">计算一次约 1~3 分钟，会占 TikTok 接口配额，所以改成手动触发；结果会在本地缓存 5 分钟。</span><br><br>' +
        '<button class="act primary" id="diagStart">仍要计算</button></div>';
      $('#diagSku').innerHTML = '';
      const startButton = $('#diagStart');
      if (startButton) {
        startButton.addEventListener('click', () => {
          $('#diagCreative').innerHTML = '<div class="loading">计算中…（约 1~3 分钟，算完自动显示）</div>';
          if (!state.diagTimer) {
            state.diagTimer = setInterval(async () => {
              if (state.tab !== 'diagnosis') { clearInterval(state.diagTimer); state.diagTimer = null; return; }
              const again = await api('/api/diagnosis?' + rangeQuery() + '&accounts=' + encodeURIComponent(accountQuery()));
              if (!again.loading) {
                clearInterval(state.diagTimer);
                state.diagTimer = null;
                renderDiagnosis();
              }
            }, 6000);
          }
        });
      }
      return;
    }
    const creative = data.creative || {};
    const sku = data.sku || {};
    $('#diagKpis').innerHTML = [
      ['待删素材', (creative.kill || []).length + ' 条'],
      ['素材浪费', money(creative.wasted || 0)],
      ['待止损 SKU', (sku.kill || []).length + ' 个'],
      ['SKU 浪费', money(sku.wasted || 0)],
    ].map(([key, value]) => '<div class="kpi"><div class="k">' + key + '</div><div class="v">' + value + '</div></div>').join('');

    const bucketBlock = (title, cls, list, empty, showAdvice) => {
      const rows = (list || []).slice(0, 8).map((row) => {
        if (row.itemId) {
          return '<div class="horseRow">' +
            '<span class="id" data-copy-item="' + esc(row.itemId) + '" title="点击复制作品ID">' + esc(String(row.itemId).slice(-8)) + '</span>' +
            '<span class="m">' + money(row.cost) + ' · ' + num(row.orders) + '单 · ROI ' + row.roi + '</span>' +
            '<button class="act" data-add-watch="' + esc(row.itemId) + '|' + esc(row.advertiserId) + '|' + esc(row.campaignId) + '">盯盘</button>' +
            '</div>';
        }
        return '<div class="horseRow">' +
          '<span>' + esc(row.sku || String(row.spu).slice(-6)) + '</span>' +
          '<span class="m">' + money(row.cost) + ' · ' + num(row.orders) + '单 · ROI ' + row.roi + (showAdvice ? ' · ' + esc(row.advice) : '') + '</span>' +
          '</div>';
      }).join('') || '<div class="empty" style="padding:10px 0">' + empty + '</div>';
      return '<div class="horse"><h4><span class="diagTag ' + cls + '">' + title + '</span><span>' + ((list || []).length) + ' 条</span></h4>' + rows + '</div>';
    };
    $('#diagCreative').innerHTML =
      bucketBlock('待删', 'kill', creative.kill, '没有该杀的素材 👍') +
      bucketBlock('观察', 'watch', creative.watch, '暂无') +
      bucketBlock('加热', 'scale', creative.scale, '暂无可加热素材');
    $('#diagSku').innerHTML = '<table><thead><tr><th>状态</th><th>建议</th><th>SKU</th><th>商品</th><th>广告组</th><th class="num">消耗</th><th class="num">订单</th><th class="num">ROI</th><th class="num">AOV</th></tr></thead><tbody>' +
      (sku.all ? [].concat(sku.kill || [], sku.fix || [], sku.scale || [], sku.watch || []).slice(0, 60).map((row) => {
        const tag = row.status === 'kill' ? 'kill' : row.status === 'fix' ? 'fix' : row.status === 'scale' ? 'scale' : 'watch';
        return '<tr><td><span class="diagTag ' + tag + '">' + (tag === 'kill' ? '止损' : tag === 'fix' ? '检查' : tag === 'scale' ? '扩量' : '观察') + '</span></td>' +
          '<td class="muted">' + esc(row.advice) + '</td><td>' + esc(row.sku || String(row.spu).slice(-6)) + '</td><td title="' + esc(row.name) + '">' + esc(row.name || '-') + '</td>' +
          '<td class="muted">' + esc(row.campaignName) + '</td><td class="num">' + money(row.cost) + '</td><td class="num">' + num(row.orders) + '</td>' +
          '<td class="num ' + roiClass(row.roi) + '">' + row.roi + '</td><td class="num">' + money(row.aov) + '</td></tr>';
      }).join('') : '<tr><td colspan="9" class="empty">当前区间没有数据</td></tr>') + '</tbody></table>';

    for (const button of document.querySelectorAll('[data-add-watch]')) {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const [itemId, advertiserId, campaignId] = button.dataset.addWatch.split('|');
        openAddModule({ advertiserId, campaignId, itemId });
      });
    }
  } catch (error) {
    $('#diagCreative').innerHTML = '<div class="empty">加载失败：' + esc(error.message) + '</div>';
  }
}

/* ---------------- 告警 / 设置 ---------------- */
async function renderAlerts() {
  const data = await api('/api/alerts');
  $('#alertBadge').textContent = data.active.length ? '(' + data.active.length + ')' : '';
  const badge2 = $('#alertBadge2');
  if (badge2) badge2.textContent = data.active.length ? '(' + data.active.length + ')' : '';
  $('#scanInfo').textContent = data.lastScanAt ? '上次扫描 ' + new Date(data.lastScanAt).toLocaleString('zh-CN') : '尚未扫描';
  const rowHtml = (row) => '<tr><td><span class="pill ' + esc(row.level) + '">' + (row.level === 'critical' ? '严重' : '警告') + '</span></td><td>' + esc(row.store) + '</td><td>' +
    (row.scope === 'creative' ? '素材' : '系列') + '</td><td title="' + esc(row.targetName) + '">' + esc(row.targetName) + '</td><td title="' + esc(row.message) + '">' + esc(row.message) +
    '</td><td class="num">' + money(row.cost) + '</td><td class="num">' + num(row.orders) + '</td></tr>';
  const head = '<thead><tr><th>级别</th><th>店铺</th><th>类型</th><th>对象</th><th>说明</th><th class="num">消耗</th><th class="num">订单</th></tr></thead>';
  $('#activeAlerts').innerHTML = data.active.length ? '<table>' + head + '<tbody>' + data.active.map(rowHtml).join('') + '</tbody></table>' : '<div class="empty">当前没有异常</div>';
  $('#historyAlerts').innerHTML = data.history.length ? '<table>' + head + '<tbody>' + data.history.slice(0, 50).map(rowHtml).join('') + '</tbody></table>' : '<div class="empty">暂无历史</div>';
}
async function renderSettings() {
  const data = await api('/api/settings');
  state.watchAll = data.watchAll !== false;
  state.watchAccounts = data.watchAccounts || [];
  $('#s-days').value = data.rules.windowDays;
  $('#s-spend').value = data.rules.spendThreshold;
  $('#s-roi').value = data.rules.roiTarget;
  $('#s-ratio').value = data.rules.roiRatio;
  $('#s-interval').value = data.monitorIntervalMinutes;
  $('#s-feishu').value = data.feishuWebhook || '';
  $('#s-creative-spend').value = data.creativeSpendThreshold || 5;
  $('#s-speed').value = data.boardSpeedThreshold || 40;
  $('#s-stall').value = data.boardStallMinutes || 120;
  $('#w-all').setAttribute('aria-pressed', String(state.watchAll));
  $('#w-sel').setAttribute('aria-pressed', String(!state.watchAll));
  const names = state.watchAccounts.map((id) => (state.accounts.find((a) => a.advertiserId === id) || {}).storeName || String(id).slice(-6));
  $('#watchInfo').textContent = state.watchAll ? '（当前：全部账户）' : '（当前：' + (names.join('、') || '未选') + '）';
}
async function saveSettings() {
  const body = {
    rules: { windowDays: +$('#s-days').value, spendThreshold: +$('#s-spend').value, roiTarget: +$('#s-roi').value, roiRatio: +$('#s-ratio').value },
    monitorIntervalMinutes: +$('#s-interval').value,
    feishuWebhook: $('#s-feishu').value.trim(),
    creativeSpendThreshold: +$('#s-creative-spend').value,
    boardSpeedThreshold: +$('#s-speed').value,
    boardStallMinutes: +$('#s-stall').value,
    watchAll: state.watchAll !== false,
    watchAccounts: state.watchAll === false
      ? (state.selected.size ? Array.from(state.selected) : state.watchAccounts)
      : [],
  };
  const saved = await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  state.watchAll = saved.watchAll !== false;
  state.watchAccounts = saved.watchAccounts || [];
  $('#saveInfo').textContent = '已保存';
  renderSettings();
  setTimeout(() => { $('#saveInfo').textContent = ''; }, 2500);
}

/* ---------------- 路由 ---------------- */
const TITLES = { desk: '展示台', watch: '盯盘', campaigns: '广告组', ai: 'AI 监控投放', export: '数据导出', products: '商品信息', diagnosis: '诊断', alerts: '告警', settings: '设置' };
async function render() {
  const tab = state.tab;
  $('#pageTitle').textContent = TITLES[tab];
  const backButton = $('#btnBackWatch');
  if (backButton) backButton.style.display = tab === 'watch' ? 'none' : '';
  if (tab === 'watch') $('#pageSub').textContent = '模块化盯盘看板';
  if (tab === 'campaigns' || tab === 'desk' || tab === 'diagnosis') {
    $('#pageSub').textContent = state.custom && state.custom.start && state.custom.end
      ? state.custom.start + ' ~ ' + state.custom.end
      : (state.selected.size === 0 ? '全部账户合并' : state.selected.size === 1 ? '单账户' : state.selected.size + ' 个账户分开对比');
  }
  const boardOnly = tab === 'watch';
  const filterBar = $('#filterBar');
  if (filterBar) {
    filterBar.classList.toggle('faded', boardOnly);
    $('#filterHint').textContent = boardOnly ? '盯盘为实时数据，不受上面筛选影响' : '';
  }
  for (const el of document.querySelectorAll('nav button')) el.setAttribute('aria-current', String(el.dataset.tab === tab));
  for (const name of ['desk', 'watch', 'campaigns', 'ai', 'export', 'products', 'diagnosis', 'alerts', 'settings']) $('#tab-' + name).hidden = name !== tab;
  window.scrollTo({ top: 0, behavior: 'instant' });
  try {
    if (tab === 'desk') await renderDesk();
    if (tab === 'watch') await renderWatch();
    if (tab === 'ai') await renderAI();
    if (tab === 'export') await renderExport();
    if (tab === 'products') await renderProducts();
    if (tab === 'diagnosis') await renderDiagnosis();
    if (tab === 'campaigns') await renderCampaigns();
    if (tab === 'alerts') await renderAlerts();
    if (tab === 'settings') await renderSettings();
  } catch (error) {
    console.error(error);
  }
}
for (const el of document.querySelectorAll('nav button')) el.addEventListener('click', () => { state.tab = el.dataset.tab; render(); });
for (const el of document.querySelectorAll('#rangeChips .chip')) el.addEventListener('click', () => {
  if (el.dataset.mode === 'custom') {
    for (const chip of document.querySelectorAll('#rangeChips .chip')) chip.setAttribute('aria-pressed', String(chip === el));
    const box = $('#customRange');
    box.hidden = !box.hidden;
    if (!box.hidden) {
      const today = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const iso = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      const end = state.custom && state.custom.end ? state.custom.end : iso(new Date(today.getTime() - 86400000));
      const start = state.custom && state.custom.start ? state.custom.start : iso(new Date(today.getTime() - 7 * 86400000));
      $('#rangeStart').value = start;
      $('#rangeEnd').value = end;
      $('#rangeStart').max = iso(today);
      $('#rangeEnd').max = iso(today);
    }
    return;
  }
  $('#customRange').hidden = true;
  state.custom = null;
  if (el.dataset.mode === 'today') { state.today = true; state.days = 1; }
  else { state.today = false; state.days = Number(el.dataset.days); }
  for (const chip of document.querySelectorAll('#rangeChips .chip')) chip.setAttribute('aria-pressed', String(chip === el));
  render();
});
$('#applyRange').addEventListener('click', () => {
  const start = $('#rangeStart').value;
  const end = $('#rangeEnd').value;
  if (!start || !end) { alert('请选择开始和结束日期'); return; }
  if (start > end) { alert('开始日期不能晚于结束日期'); return; }
  state.custom = { start, end };
  $('#pageSub').textContent = start + ' ~ ' + end + '（加载中…）';
  state.today = false;
  state.days = Math.max(1, Math.round((new Date(end) - new Date(start)) / 86400000) + 1);
  localStorage.setItem('tiktok-ads-custom-range', JSON.stringify(state.custom));
  $('#customRange').hidden = false;
  render();
});
for (const el of document.querySelectorAll('#metricChips .chip')) el.addEventListener('click', () => {
  state.metric = el.dataset.metric;
  for (const chip of document.querySelectorAll('#metricChips .chip')) chip.setAttribute('aria-pressed', String(chip === el));
  render();
});
for (const el of document.querySelectorAll('#modalRangeChips .chip')) el.addEventListener('click', () => {
  if (el.dataset.mode === 'custom') {
    const box = $('#modalCustomRange');
    box.hidden = !box.hidden;
    const today = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const iso = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    const end = state.modal.custom ? state.modal.custom.end : iso(today);
    const start = state.modal.custom ? state.modal.custom.start : iso(new Date(today.getTime() - 6 * 86400000));
    $('#modalStart').value = start;
    $('#modalEnd').value = end;
    for (const chip of document.querySelectorAll('#modalRangeChips .chip')) chip.setAttribute('aria-pressed', String(chip.dataset.mode === 'custom'));
    return;
  }
  state.modal.custom = null;
  $('#modalCustomRange').hidden = true;
  state.modal.days = Number(el.dataset.days);
  for (const chip of document.querySelectorAll('#modalRangeChips .chip')) chip.setAttribute('aria-pressed', String(chip === el));
  renderModal();
});
for (const el of document.querySelectorAll('#modalMetricChips .chip')) el.addEventListener('click', () => {
  state.modal.metric = el.dataset.metric;
  for (const chip of document.querySelectorAll('#modalMetricChips .chip')) chip.setAttribute('aria-pressed', String(chip === el));
  renderModal();
});
$('#modalApply').addEventListener('click', () => {
  const start = $('#modalStart').value;
  const end = $('#modalEnd').value;
  if (!start || !end) { alert('请选择开始和结束日期'); return; }
  if (start > end) { alert('开始日期不能晚于结束日期'); return; }
  state.modal.custom = { start, end };
  state.modal.days = Math.max(1, Math.round((new Date(end) - new Date(start)) / 86400000) + 1);
  for (const chip of document.querySelectorAll('#modalRangeChips .chip')) chip.setAttribute('aria-pressed', String(chip.dataset.mode === 'custom'));
  renderModal();
});
$('#modalClose').addEventListener('click', () => { $('#modal').removeAttribute('open'); state.modal = null; });
$('#expandClose').addEventListener('click', () => { $('#expandModal').removeAttribute('open'); state.expandModuleId = null; });
$('#expandModal').addEventListener('click', (event) => { if (event.target === $('#expandModal')) { $('#expandModal').removeAttribute('open'); state.expandModuleId = null; } });
$('#modal').addEventListener('click', (event) => { if (event.target === $('#modal')) { $('#modal').removeAttribute('open'); state.modal = null; } });
$('#btnAlerts').addEventListener('click', () => { state.tab = 'alerts'; render(); });
$('#btnSettings').addEventListener('click', () => { state.tab = 'settings'; render(); });
$('#btnBackWatch').addEventListener('click', () => { state.tab = 'watch'; render(); });
const tzSelectNode = $('#tzSelect');
if (tzSelectNode) {
  tzSelectNode.addEventListener('change', () => {
    state.tz = tzSelectNode.value;
    try { localStorage.setItem('tiktok-ads-tz', state.tz); } catch { /* ignore */ }
    render();
    startTzClock();
  });
}
$('#btnRefresh').addEventListener('click', render);
$('#btnScan').addEventListener('click', async () => {
  $('#btnScan').textContent = '扫描中…';
  try { await api('/api/scan?accounts=' + encodeURIComponent(accountQuery()), { method: 'POST' }); } catch (error) { console.error(error); }
  $('#btnScan').textContent = '立即扫描';
  render();
});
$('#btnSave').addEventListener('click', saveSettings);
bindBoardControls();
bindDrillEvents();
bindProductControls();
$('#w-all').addEventListener('click', () => {
  state.watchAll = true;
  $('#w-all').setAttribute('aria-pressed', 'true');
  $('#w-sel').setAttribute('aria-pressed', 'false');
  $('#watchInfo').textContent = '（保存后自动扫描全部账户）';
});
$('#w-sel').addEventListener('click', () => {
  state.watchAll = false;
  $('#w-all').setAttribute('aria-pressed', 'false');
  $('#w-sel').setAttribute('aria-pressed', 'true');
  const names = Array.from(state.selected).map((id) => (state.accounts.find((a) => a.advertiserId === id) || {}).storeName || String(id).slice(-6));
  $('#watchInfo').textContent = names.length ? '（保存后只监控：' + names.join('、') + '）' : '（请先在左侧勾选要监控的账户）';
});

(async () => {
  // Deep links: ?tab=campaigns&days=30&accounts=id1,id2&drill=id|campaignId
  const params = new URLSearchParams(location.search);
  if (params.get('days')) state.days = Math.max(1, Number(params.get('days')) || 7);
  if (params.get('tab') && TITLES[params.get('tab')]) state.tab = params.get('tab');
  try {
    const stored = JSON.parse(localStorage.getItem('tiktok-ads-custom-range') || 'null');
    if (stored && stored.start && stored.end) state.custom = stored;
  } catch { /* ignore */ }
  if (params.get('accounts')) state.selected = new Set(params.get('accounts').split(',').map((v) => v.trim()).filter(Boolean));
  if (params.get('mode') === 'today') { state.today = true; state.days = 1; }
  if (params.get('campaign')) {
    state.watch.pending = {
      advertiserId: params.get('accounts') ? params.get('accounts').split(',')[0] : '',
      campaignId: params.get('campaign'),
      itemId: params.get('item') || '',
    };
  }
  try { await loadAccounts(); } catch (error) { $('#accountList').innerHTML = '<div class="empty">账户加载失败：' + esc(error.message) + '</div>'; }
  if (state.selected.size) {
    $('#chkAll').checked = false;
    for (const el of document.querySelectorAll('[data-account]')) el.checked = state.selected.has(el.dataset.account);
    $('#pageSub').textContent = state.selected.size + ' 个账户分开对比';
  }
  const customActive = Boolean(state.custom && state.custom.start && state.custom.end);
  if (customActive) { $('#rangeStart').value = state.custom.start; $('#rangeEnd').value = state.custom.end; }
  $('#customRange').hidden = !customActive;
  for (const chip of document.querySelectorAll('#rangeChips .chip')) {
    let active = false;
    if (chip.dataset.mode === 'custom') active = customActive;
    else if (customActive) active = false;
    else if (chip.dataset.mode === 'today') active = state.today;
    else active = !state.today && Number(chip.dataset.days) === state.days;
    chip.setAttribute('aria-pressed', String(active));
  }
  for (const chip of document.querySelectorAll('#boardInterval .chip')) {
    chip.setAttribute('aria-pressed', String(Number(chip.dataset.interval) === (Number(localStorage.getItem('tiktok-ads-board-interval')) || 60)));
  }
  try {
    const savedTz = localStorage.getItem('tiktok-ads-tz');
    if (savedTz) state.tz = savedTz;
  } catch { /* ignore */ }
  await loadTimezones();
  const tzNode = $('#tzSelect');
  if (tzNode) tzNode.value = state.tz || 'account';
  startTzClock();
  const drillParam = params.get('drill');
  if (drillParam && drillParam.includes('|')) {
    const [advertiserId, campaignId] = drillParam.split('|');
    state.pendingDrill = { advertiserId, campaignId };
  }
  const trendParam = params.get('trend');
  if (trendParam && trendParam.includes('|')) {
    const [kind, advertiserId, campaignId, id, label] = trendParam.split('|');
    state.pendingTrend = { kind, advertiserId, campaignId: campaignId || undefined, id: id || undefined, name: label ? decodeURIComponent(label) : undefined };
  }
  await render();
  // 预热盯盘数据：首屏不管停在哪个 tab，后台先把看板拉一次
  if (state.tab !== 'watch') {
    api('/api/board').then((list) => { board.modules = list.modules || []; return api('/api/board/data'); })
      .then((payload) => {
        board.data = payload.modules || [];
        try { sessionStorage.setItem('tiktok-ads-board-cache', JSON.stringify(board.data)); } catch { /* quota */ }
      })
      .catch(() => { /* 首屏预热失败无所谓，切过去会再拉 */ });
  }
  if (params.get('add') === '1') openAddModule(null);
  if (state.pendingTrend) {
    const pending = state.pendingTrend;
    state.pendingTrend = null;
    await openModal({
      kind: pending.kind,
      advertiserId: pending.advertiserId,
      campaignId: pending.campaignId,
      spu: pending.kind === 'sku' ? pending.id : undefined,
      itemId: pending.kind === 'creative' ? pending.id : undefined,
      name: pending.name,
      days: state.days,
    });
  }
  setInterval(() => { if (state.tab === 'desk' && !state.modal) render(); }, 120000);
})();
</script></body></html>`

/**
 * @typedef {object} DashboardDeps
 * @property {() => { authorized: boolean, mode: string }} getStatus
 * @property {() => Promise<{ rules: object, monitorIntervalMinutes: number, feishuWebhook: string }>} getSettings
 * @property {(patch: object) => Promise<object>} saveSettings
 * @property {() => Promise<object[]>} listAccounts
 * @property {(days: number, accountIds?: string[]) => Promise<object>} getDesk
 * @property {(days: number, accountIds?: string[]) => Promise<object>} getCampaigns
 * @property {(days: number, advertiserId: string, campaignId: string) => Promise<object>} getCampaignDetail
 * @property {(query: object) => Promise<object>} getTrend
 * @property {() => Promise<object>} getAlerts
 * @property {() => Promise<object>} runScan
 */

/**
 * Start the dashboard server.
 * @param {DashboardDeps} deps
 * @param {{ port: number, host?: string }} options
 * @returns {Promise<{ url: string, close: () => void, port: number }>}
 */
export async function startDashboard(deps, { port, host = '127.0.0.1' }) {
  const readJson = async (request, maxBytes = 512 * 1024) => {
    const chunks = []
    let total = 0
    for await (const chunk of request) {
      total += chunk.length
      if (total > maxBytes) throw new Error('body too large')
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  }

  /**
   * 本地面板的请求防护：
   *  - Host 必须是 127.0.0.1 / localhost（防 DNS rebinding）
   *  - 有 Origin 时必须同源（防 CSRF）
   *  - 写操作必须是 application/json（浏览器发不出这种跨域简单请求）
   */
  const guard = (request) => {
    const hostHeader = String(request.headers.host || '')
    const hostName = hostHeader.replace(/:\d+$/, '').toLowerCase()
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostName)) {
      return 'host not allowed'
    }
    const origin = request.headers.origin
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(String(origin))) {
      return 'origin not allowed'
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const type = String(request.headers['content-type'] || '')
      if (!type.toLowerCase().includes('application/json')) return 'content-type must be application/json'
    }
    return null
  }
  const server = http.createServer(async (request, response) => {
    const rejected = guard(request)
    if (rejected) {
      response.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ error: rejected }))
      return
    }
    const url = new URL(request.url || '/', `http://${host}:${port}`)
    const json = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(body))
    }
    const accountIds = () => (url.searchParams.get('accounts') || '').split(',').map((item) => item.trim()).filter(Boolean)
    const rangeQuery = (source) => ({
      days: Number(source.searchParams.get('days')) || 7,
      today: source.searchParams.get('today') === '1',
      start: source.searchParams.get('start') || undefined,
      end: source.searchParams.get('end') || undefined,
    })
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        response.end(PAGE)
        return
      }
      if (url.pathname === '/api/accounts') return json(200, { accounts: await deps.listAccounts() })
      if (url.pathname === '/api/desk') return json(200, await deps.getDesk(rangeQuery(url), accountIds()))
      if (url.pathname === '/api/campaigns') return json(200, await deps.getCampaigns(rangeQuery(url), accountIds()))
      if (url.pathname === '/api/campaign-detail') {
        return json(200, await deps.getCampaignDetail(
          rangeQuery(url),
          String(url.searchParams.get('advertiser') || ''),
          String(url.searchParams.get('campaign') || ''),
          { skipSkuMap: url.searchParams.get('light') === '1' },
        ))
      }
      if (url.pathname === '/api/trend') {
        return json(200, await deps.getTrend({
          days: Number(url.searchParams.get('days')) || 7,
          today: url.searchParams.get('today') === '1',
          start: url.searchParams.get('start') || undefined,
          end: url.searchParams.get('end') || undefined,
          advertiserId: String(url.searchParams.get('advertiser') || ''),
          campaignId: url.searchParams.get('campaign') || undefined,
          spu: url.searchParams.get('spu') || undefined,
          itemId: url.searchParams.get('item') || undefined,
        }))
      }
      if (url.pathname === '/api/watch') {
        return json(200, await deps.getWatch({
          advertiserId: String(url.searchParams.get('advertiser') || ''),
          campaignId: url.searchParams.get('campaign') || undefined,
          itemId: url.searchParams.get('item') || undefined,
        }))
      }
      if (url.pathname === '/api/diagnosis') return json(200, await deps.getDiagnosis(rangeQuery(url), accountIds()))
      if (url.pathname === '/api/inspect') return json(200, await deps.getInspect(rangeQuery(url), accountIds()))
      if (url.pathname === '/api/timezones') return json(200, await deps.getTimezones())
      if (url.pathname === '/api/creative-board') return json(200, await deps.getCreativeBoard(rangeQuery(url), accountIds()))
      if (url.pathname === '/api/board/compare') {
        return json(200, await deps.dayCompare(
          String(url.searchParams.get('module') || ''),
          String(url.searchParams.get('date') || ''),
        ))
      }
      if (url.pathname === '/api/creative' && request.method === 'POST') {
        const payload = await readJson(request)
        return json(200, { ok: true, meta: deps.setGlobalCreativeMeta(payload.itemId, payload) })
      }
      if (url.pathname === '/api/board/expanded') {
        return json(200, await deps.expandedCreatives(
          String(url.searchParams.get('module') || ''),
          {
            mode: url.searchParams.get('mode') || 'none',
            days: Number(url.searchParams.get('days')) || 7,
            date: url.searchParams.get('date') || '',
          },
        ))
      }
      if (url.pathname === '/api/board/creative' && request.method === 'POST') {
        const payload = await readJson(request)
        return json(200, { ok: true, meta: deps.setCreativeMeta(payload.moduleId, payload.itemId, payload) })
      }
      if (url.pathname === '/api/products') return json(200, deps.listProducts())
      if (url.pathname === '/api/products/join') return json(200, await deps.productAdsJoin(rangeQuery(url), accountIds()))
      if (url.pathname === '/api/products/import' && request.method === 'POST') {
        const payload = await readJson(request, 8 * 1024 * 1024)
        return json(200, await deps.importProducts(payload.base64, { fileName: payload.fileName, region: payload.region }))
      }
      if (url.pathname === '/api/export' && request.method === 'POST') {
        const payload = await readJson(request)
        const result = await deps.runExport({ start: payload.start, end: payload.end, out: payload.out })
        return json(200, result)
      }
      if (url.pathname === '/api/export/status') return json(200, deps.exportStatus())
      if (url.pathname === '/api/export/download') {
        const status = deps.exportStatus()
        const name = String(url.searchParams.get('name') || '').replace(/[^0-9A-Za-z._-]/g, '')
        let file = (status.files || []).find((item) => item.name === name)
        if (!file) {
          // job 里的列表可能因为重启丢了，直接按导出目录兜底
          const pathMod = await import('node:path')
          const osMod = await import('node:os')
          const dir = status.dir || pathMod.join(osMod.homedir(), 'Desktop', '广告', '每日广告订单')
          const candidate = pathMod.join(dir, name)
          if (/^\d{4}-\d{2}-\d{2}\.xlsx$/.test(name) && fs.existsSync(candidate)) {
            file = { name, path: candidate }
          }
        }
        if (!file) return json(404, { error: '文件不存在' })
        const stat = fs.statSync(file.path)
        response.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Length': stat.size,
          'Content-Disposition': 'attachment; filename="' + encodeURIComponent(name) + '"',
        })
        fs.createReadStream(file.path).pipe(response)
        return
      }
      if (url.pathname === '/api/board') return json(200, { modules: deps.board.list() })
      if (url.pathname === '/api/board/data') return json(200, await deps.board.data())
      if (url.pathname === '/api/board/add' && request.method === 'POST') {
        const payload = await readJson(request)
        return json(200, deps.board.add(payload))
      }
      if (url.pathname === '/api/board/update' && request.method === 'POST') {
        const payload = await readJson(request)
        const { id, ...patch } = payload
        return json(200, deps.board.update(id, patch))
      }
      if (url.pathname === '/api/board/remove' && request.method === 'POST') {
        const payload = await readJson(request)
        return json(200, deps.board.remove(payload.id))
      }
      if (url.pathname === '/api/board/search' && request.method === 'POST') {
        const payload = await readJson(request)
        return json(200, await deps.board.search(payload.q || '', { rebuild: payload.rebuild === true }))
      }
      if (url.pathname === '/api/board/preview' && request.method === 'POST') {
        return json(200, await deps.board.preview(await readJson(request)))
      }
      if (url.pathname === '/api/alerts') return json(200, await deps.getAlerts())
      if (url.pathname === '/api/settings' && request.method === 'GET') return json(200, { ...(await deps.getSettings()), ...deps.getStatus() })
      if (url.pathname === '/api/settings' && request.method === 'POST') {
        const chunks = []
        for await (const chunk of request) {
          chunks.push(chunk)
          if (Buffer.concat(chunks).length > 64 * 1024) throw new Error('body too large')
        }
        const patch = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        return json(200, { ok: true, ...(await deps.saveSettings(patch)) })
      }
      if (url.pathname === '/api/scan' && request.method === 'POST') return json(200, await deps.runScan({ accountIds: accountIds() }))
      return json(404, { error: 'not found' })
    } catch (error) {
      return json(500, { error: String(error?.message || error) })
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve())
  })
  return {
    url: `http://${host}:${port}/`,
    port,
    close: () => {
      try {
        server.close()
      } catch { /* already closed */ }
    },
  }
}
