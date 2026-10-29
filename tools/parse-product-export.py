#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Parse a TikTok Seller Center product export / batch-edit template into JSON.

The export has (at least) these shapes:
  - row 1: english field names (product_id, seller_sku, product_name, ...)
  - row 2: meta (V4, All_Information, ...)
  - row 3: chinese labels (商品 ID, 商家 SKU, 商品名称 ...)
  - row 4: required flags (必填 / 选填 ...)
  - row 5+: data

We detect the header row automatically (first row containing product_id/商品 ID or
seller_sku/商家 SKU), then map both english and chinese names.

Usage: python parse-product-export.py <xlsx-or-csv> <out.json>
"""
import csv
import json
import sys

import openpyxl

PRODUCT_ID = ["product_id", "商品 id", "商品id", "product id"]
SKU_ID = ["sku_id", "sku id", "sku id"]
SELLER_SKU = ["seller_sku", "商家 sku", "商家sku", "seller sku", "sku"]
NAME = ["product_name", "商品名称", "商品名"]
PRICE = ["price", "零售价（本地币种）", "零售价(本地币种)", "零售价"]
STATUS = ["product_status", "商品状态"]
CATEGORY = ["category", "类目"]
VARIATION = ["variation_value", "变体选项"]
IMAGE = ["main_image", "主图"]
DESCRIPTION = ["product_description", "商品描述"]
BRAND = ["brand", "品牌"]


def norm(value):
    if value is None:
        return ""
    return str(value).strip()


def find_header_row(rows):
    for index, row in enumerate(rows[:12]):
        cells = [norm(cell).lower() for cell in row]
        joined = " | ".join(cells)
        if any(key in joined for key in ("product_id", "商品 id", "商品id")) and (
            "seller_sku" in joined or "商家 sku" in joined or "sku" in joined
        ):
            return index
    return None


def build_index(header):
    """先精确匹配，再前缀匹配；seller_sku 不能被前面的 sku_id 抢走。"""
    index = {}
    lowered = [norm(cell).lower() for cell in header]
    fields = (
        ("productId", PRODUCT_ID),
        ("skuId", SKU_ID),
        ("sellerSku", SELLER_SKU),
        ("name", NAME),
        ("price", PRICE),
        ("status", STATUS),
        ("category", CATEGORY),
        ("variation", VARIATION),
        ("image", IMAGE),
        ("description", DESCRIPTION),
        ("brand", BRAND),
    )
    for key, candidates in fields:
        lowered_candidates = [candidate.lower() for candidate in candidates]
        matched = None
        for position, cell in enumerate(lowered):
            if cell in lowered_candidates:
                matched = position
                break
        if matched is None:
            for position, cell in enumerate(lowered):
                # seller_sku 的前缀匹配要排除 xxx_id / sku id 这类列
                if key == "sellerSku" and ("id" in cell):
                    continue
                if any(cell.startswith(candidate) for candidate in lowered_candidates):
                    matched = position
                    break
        if matched is not None:
            index[key] = matched
    return index


def read_xlsx(path):
    workbook = openpyxl.load_workbook(path, data_only=True)
    sheet = workbook[workbook.sheetnames[0]]
    return [list(row) for row in sheet.iter_rows(values_only=True)]


def read_csv(path):
    with open(path, "r", encoding="utf-8-sig", newline="") as handle:
        return [row for row in csv.reader(handle)]


def main():
    source = sys.argv[1]
    target = sys.argv[2]
    rows = read_csv(source) if source.lower().endswith(".csv") else read_xlsx(source)
    header_row = find_header_row(rows)
    if header_row is None:
        print(json.dumps({"ok": False, "error": "找不到表头（需要 product_id / 商家 SKU 列）"}, ensure_ascii=False))
        sys.exit(2)
    header = rows[header_row]
    index = build_index(header)
    products = []
    seen = set()
    for row in rows[header_row + 1:]:
        values = list(row)
        def cell(key):
            position = index.get(key)
            if position is None or position >= len(values):
                return ""
            return norm(values[position])

        product_id = cell("productId")
        seller_sku = cell("sellerSku")
        # 跳过模板的元信息行（V4 / metric / 必填 / 说明文字等），只保留真实商品行
        if not product_id.isdigit() or len(product_id) < 6:
            continue
        key = (product_id, seller_sku)
        if key in seen:
            continue
        seen.add(key)
        products.append(
            {
                "productId": product_id,
                "skuId": cell("skuId"),
                "sellerSku": seller_sku,
                "name": cell("name"),
                "price": cell("price"),
                "status": cell("status"),
                "category": cell("category"),
                "variation": cell("variation"),
                "image": cell("image"),
                "brand": cell("brand"),
                "description": cell("description")[:200],
            }
        )
    with open(target, "w", encoding="utf-8") as handle:
        json.dump({"ok": True, "headerRow": header_row + 1, "count": len(products), "products": products}, handle, ensure_ascii=False)
    print(json.dumps({"ok": True, "headerRow": header_row + 1, "count": len(products)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
