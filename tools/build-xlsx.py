#!/usr/bin/env python
"""Build a formatted TikTok daily-report workbook from report.json.

Usage: python build-xlsx.py <report-dir>

Sheets: 商品明细 / 素材明细 / 按天明细 / 说明（按需求不再输出系列级、账户级汇总）
"""
import json
import os
import sys

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

HEADER_FILL = PatternFill("solid", fgColor="1F2937")
HEADER_FONT = Font(bold=True, color="FFFFFF", size=10)
TOTAL_FILL = PatternFill("solid", fgColor="EEF2FF")
THIN = Side(style="thin", color="D1D5DB")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
MONEY = '#,##0.00'
INT = '#,##0'


def load(report_dir):
    with open(os.path.join(report_dir, "report.json"), "r", encoding="utf-8") as handle:
        return json.load(handle)


def style_header(ws, columns):
    for index, title in enumerate(columns, start=1):
        cell = ws.cell(row=1, column=index, value=title)
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = BORDER
    ws.row_dimensions[1].height = 22
    ws.freeze_panes = "A2"


def autofit(ws, columns, widths=None):
    for index, title in enumerate(columns, start=1):
        letter = get_column_letter(index)
        if widths and title in widths:
            ws.column_dimensions[letter].width = widths[title]
            continue
        longest = len(str(title))
        for row in ws.iter_rows(min_row=2, min_col=index, max_col=index, values_only=True):
            value = row[0]
            if value is None:
                continue
            longest = max(longest, min(len(str(value)), 60))
        ws.column_dimensions[letter].width = min(46, max(9, longest * 1.7 + 3))


def write_sheet(wb, title, rows, columns, formats, widths=None, total_row=None):
    ws = wb.create_sheet(title)
    style_header(ws, columns)
    for row_index, row in enumerate(rows, start=2):
        for column_index, column in enumerate(columns, start=1):
            value = row.get(column)
            cell = ws.cell(row=row_index, column=column_index, value=value)
            cell.border = BORDER
            fmt = formats.get(column)
            if fmt:
                cell.number_format = fmt
    if total_row:
        row_index = len(rows) + 2
        for column_index, column in enumerate(columns, start=1):
            value = total_row.get(column, "")
            cell = ws.cell(row=row_index, column=column_index, value=value)
            cell.fill = TOTAL_FILL
            cell.font = Font(bold=True)
            cell.border = BORDER
            fmt = formats.get(column)
            if fmt:
                cell.number_format = fmt
        ws.cell(row=row_index, column=1).value = "合计"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(columns))}{max(1, len(rows) + 1)}"
    autofit(ws, columns, widths)
    return ws


def main():
    if len(sys.argv) < 2:
        print("usage: build-xlsx.py <report-dir>", file=sys.stderr)
        return 2
    report_dir = sys.argv[1]
    payload = load(report_dir)
    meta = payload.get("range", {})
    totals = payload.get("totals", {})

    wb = Workbook()
    wb.remove(wb.active)

    # 只输出明细子表；系列级/账户级汇总按需求取消（合计仍写在「说明」页）。

    daily = payload.get("daily") or []
    if daily:
        daily_columns = ["日期", "账户", "店铺", "推广系列ID", "推广系列", "消耗", "订单", "GMV", "ROI"]
        daily_formats = {"消耗": MONEY, "订单": INT, "GMV": MONEY, "ROI": '0.00'}
        daily_widths = {"日期": 12, "账户": 34, "店铺": 16, "推广系列ID": 20, "推广系列": 26}
        ws = write_sheet(wb, "按天明细", daily, daily_columns, daily_formats, daily_widths)
        # Highlight low-ROI rows (delivering money but weak return).
        warn_fill = PatternFill("solid", fgColor="FEF3C7")
        for row_index in range(2, len(daily) + 2):
            roi = ws.cell(row=row_index, column=9).value
            cost = ws.cell(row=row_index, column=6).value or 0
            if isinstance(roi, (int, float)) and cost > 0 and roi < 10:
                for column_index in range(1, len(daily_columns) + 1):
                    ws.cell(row=row_index, column=column_index).fill = warn_fill

    products = payload.get("products") or []
    if products:
        product_columns = ["账户", "店铺", "商品SPU", "商品名称", "SKU", "消耗", "订单", "GMV", "ROI", "单均成本"]
        product_formats = {"消耗": MONEY, "订单": INT, "GMV": MONEY, "ROI": '0.00', "单均成本": MONEY}
        product_widths = {"账户": 34, "店铺": 16, "商品SPU": 22, "商品名称": 36, "SKU": 20}
        write_sheet(wb, "商品明细", products, product_columns, product_formats, product_widths)

    creatives = payload.get("creatives") or []
    if creatives:
        creative_columns = ["账户", "店铺", "帖子ID", "帖子链接", "消耗", "订单", "GMV", "ROI", "商品曝光", "商品点击", "点击率"]
        creative_formats = {"消耗": MONEY, "订单": INT, "GMV": MONEY, "ROI": '0.00', "商品曝光": INT, "商品点击": INT, "点击率": '0.00"%"'}
        creative_widths = {"账户": 34, "店铺": 16, "帖子ID": 22, "帖子链接": 48}
        write_sheet(wb, "素材明细", creatives, creative_columns, creative_formats, creative_widths)

    product_daily = payload.get("productDaily") or []
    if product_daily:
        pd_columns = ["日期", "账户", "店铺", "商品SPU", "商品名称", "SKU", "消耗", "订单", "GMV", "ROI"]
        pd_formats = {"消耗": MONEY, "订单": INT, "GMV": MONEY, "ROI": '0.00'}
        pd_widths = {"日期": 12, "账户": 34, "店铺": 16, "商品SPU": 22, "商品名称": 34, "SKU": 18}
        write_sheet(wb, "商品按天", product_daily, pd_columns, pd_formats, pd_widths)

    sku_sales = (payload.get("skuSales") or {}).get("rows") or []
    if sku_sales:
        sku_columns = ["日期", "站点", "SKU", "产品名称", "销量", "含税销售额", "不含税销售额", "毛利", "毛利率"]
        sku_formats = {"销量": INT, "含税销售额": MONEY, "不含税销售额": MONEY, "毛利": MONEY, "毛利率": '0.00%'}
        sku_widths = {"日期": 12, "站点": 8, "SKU": 18, "产品名称": 34}
        write_sheet(wb, "SKU销量", sku_sales, sku_columns, sku_formats, sku_widths)

    info = wb.create_sheet("说明")
    info.column_dimensions["A"].width = 22
    info.column_dimensions["B"].width = 92
    info_rows = [
        ("生成时间", payload.get("generatedAt", "")),
        ("统计区间", f"{meta.get('start', '')} ~ {meta.get('end', '')}（{meta.get('days', 1)} 天）"),
        ("数据来源", "TikTok 官方 Ads MCP（layer 模式）"),
        ("数据口径", "GMV Max 报告用 gmv_max_report_get（cost/orders/gross_revenue/roi）；经典 Ads 用 report_integrated_get"),
        ("ROI 定义", "gross_revenue ÷ cost（TikTok 口径，未扣佣金/退款）"),
        ("代理", payload.get("proxy") or "直连"),
        ("合计消耗", totals.get("消耗合计", 0)),
        ("合计订单", totals.get("订单合计", 0)),
        ("合计GMV", totals.get("GMV合计", 0)),
        ("合计ROI", totals.get("ROI", 0)),
        ("错误", "；".join(payload.get("errors", [])[:10]) or "无"),
        ("SKU 销量来源", (payload.get("skuSales") or {}).get("source") or "未找到 SKU 销量表"),
        ("SKU 数据覆盖日期", "、".join((payload.get("skuSales") or {}).get("availableDates", [])[-8:]) or "无"),
        ("提示", "只输出明细子表（商品/素材/SKU销量/按天）；0 消耗的行已剔除。按天表低 ROI(<10) 行标注黄色。"),
    ]
    for row_index, (key, value) in enumerate(info_rows, start=1):
        info.cell(row=row_index, column=1, value=key).font = Font(bold=True)
        cell = info.cell(row=row_index, column=2, value=value)
        cell.alignment = Alignment(wrap_text=True, vertical="top")

    target = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2].endswith(".xlsx") else os.path.join(report_dir, os.path.basename(report_dir) + ".xlsx")
    wb.save(target)
    print(target)
    return 0


if __name__ == "__main__":
    sys.exit(main())
