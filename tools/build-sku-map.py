#!/usr/bin/env python
"""Normalize a TikTok Shop product export into sku-map.csv.

Accepts .xlsx / .csv / .tsv with a header row. Recognized columns (English or
Chinese): product_id / item_group_id / 商品 ID; seller_sku / sku / 商家 SKU;
optional product_name / 商品名称 / SKU ID.

Writes a 3-column CSV (product_id,seller_sku,product_name) to the path given as
argv[2] (default: stdout). Multiple SKUs per product are emitted as a
semicolon-joined list so the join stays one row per product.

Usage: python build-sku-map.py <input> [output.csv] [--header-row N]
"""
import csv
import io
import os
import sys

PRODUCT_KEYS = ("product_id", "item_group_id", "商品id", "商品 id", "商品id（spu）", "spu_id")
SKU_KEYS = ("seller_sku", "商家sku", "商家 sku", "sku", "sku_id", "sku id", "seller sku")
NAME_KEYS = ("product_name", "商品名称", "商品名", "product name")


def load_rows(path):
    lower = path.lower()
    if lower.endswith((".xlsx", ".xlsm")):
        from openpyxl import load_workbook
        # NOT read_only: Seller Center exports ship a stale <dimension> record, and
        # read-only mode then believes the sheet has 5 rows and yields no data.
        wb = load_workbook(path, data_only=True)
        try:
            for ws in wb.worksheets:
                if ws.title in ("Instruction", "HiddenStyle", "HiddenAttr", "TemplateConfig", "Brand"):
                    continue
                for row in ws.iter_rows(values_only=True):
                    yield ["" if cell is None else str(cell).strip() for cell in row]
        finally:
            wb.close()
        return
    raw = open(path, "rb").read()
    for encoding in ("utf-8-sig", "utf-16", "gbk", "latin-1"):
        try:
            text = raw.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise SystemExit(f"无法解码 {path}")
    delimiter = "\t" if lower.endswith(".tsv") else ","
    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    for row in reader:
        yield [cell.strip() for cell in row]


def find_index(header, keys):
    normalized = [cell.replace(" ", "").lower() for cell in header]
    for key in keys:
        needle = key.replace(" ", "").lower()
        for index, cell in enumerate(normalized):
            if cell == needle:
                return index
    for key in keys:
        needle = key.replace(" ", "").lower()
        for index, cell in enumerate(normalized):
            if needle and needle in cell:
                return index
    return -1


def collect(rows, header_row):
    """Extract products using the given 1-based header row. Returns dict."""
    if header_row > len(rows):
        return {}
    header = rows[header_row - 1]
    product_index = find_index(header, PRODUCT_KEYS)
    sku_index = find_index(header, SKU_KEYS)
    if product_index < 0 or sku_index < 0:
        return {}
    name_index = find_index(header, NAME_KEYS)
    products = {}
    for row in rows[header_row:]:
        if len(row) <= max(product_index, sku_index):
            continue
        product_id = row[product_index].strip()
        if not product_id.isdigit():
            continue
        sku = row[sku_index].strip()
        entry = products.setdefault(product_id, {"skus": [], "name": ""})
        if sku and sku not in entry["skus"]:
            entry["skus"].append(sku)
        if name_index >= 0 and name_index < len(row) and not entry["name"]:
            entry["name"] = row[name_index].strip()
    # Keep only products that actually carry a SKU.
    return {key: value for key, value in products.items() if value["skus"]}


def main():
    if len(sys.argv) < 2:
        print("usage: build-sku-map.py <input.xlsx|csv> [output.csv] [--header-row N]", file=sys.stderr)
        return 2
    source = sys.argv[1]
    target = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith("--") else None
    explicit_header = None
    if "--header-row" in sys.argv:
        try:
            explicit_header = max(1, int(sys.argv[sys.argv.index("--header-row") + 1]))
        except (IndexError, ValueError):
            explicit_header = None
    if not os.path.exists(source):
        print(f"找不到文件：{source}", file=sys.stderr)
        return 1

    rows = list(load_rows(source))
    if not rows:
        print("文件没有内容", file=sys.stderr)
        return 1

    if explicit_header:
        products = collect(rows, explicit_header)
        used_header = explicit_header
    else:
        # Auto-detect: pick the header row that yields the most products
        # (exports sometimes carry a version/metric row above the real header).
        products = {}
        used_header = 1
        for candidate in range(1, min(8, len(rows)) + 1):
            attempt = collect(rows, candidate)
            if len(attempt) > len(products):
                products = attempt
                used_header = candidate
        if not products:
            header = rows[0] if rows else []
            print(f"未识别到列。首行表头：{header[:20]}", file=sys.stderr)
            print(f"需要 product_id 列与 sku 列（可识别：{PRODUCT_KEYS} / {SKU_KEYS}）", file=sys.stderr)
            return 1
    print(f"header row={used_header}, products={len(products)}", file=sys.stderr)

    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["product_id", "seller_sku", "product_name"])
    for product_id, entry in sorted(products.items()):
        writer.writerow([product_id, ";".join(entry["skus"]), entry["name"]])

    text = out.getvalue()
    if target:
        with open(target, "w", encoding="utf-8-sig", newline="") as handle:
            handle.write(text)
        print(f"wrote {len(products)} products -> {target}", file=sys.stderr)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
