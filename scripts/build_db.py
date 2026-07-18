#!/usr/bin/env python3
"""Builds data/berka.db (SQLite) from the 8 Berka dataset CSVs in data/raw/.

CSV files are ';'-separated. Missing values are encoded as '' or '?' in the
source data and are stored as SQL NULL.
"""
import csv
import os
import sqlite3

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR = os.path.join(ROOT, "data", "raw")
DB_PATH = os.path.join(ROOT, "data", "berka.db")

# table -> (source csv, [(column, sql_type), ...])
TABLES = {
    "account": ("account.csv", [
        ("account_id", "INTEGER"), ("district_id", "INTEGER"),
        ("frequency", "TEXT"), ("date", "TEXT"),
    ]),
    "card": ("card.csv", [
        ("card_id", "INTEGER"), ("disp_id", "INTEGER"),
        ("type", "TEXT"), ("issued", "TEXT"),
    ]),
    "client": ("client.csv", [
        ("client_id", "INTEGER"), ("birth_number", "TEXT"),
        ("district_id", "INTEGER"),
    ]),
    "disp": ("disp.csv", [
        ("disp_id", "INTEGER"), ("client_id", "INTEGER"),
        ("account_id", "INTEGER"), ("type", "TEXT"),
    ]),
    "district": ("district.csv", [
        ("A1", "INTEGER"), ("A2", "TEXT"), ("A3", "TEXT"), ("A4", "INTEGER"),
        ("A5", "INTEGER"), ("A6", "INTEGER"), ("A7", "INTEGER"), ("A8", "INTEGER"),
        ("A9", "INTEGER"), ("A10", "REAL"), ("A11", "INTEGER"), ("A12", "REAL"),
        ("A13", "REAL"), ("A14", "INTEGER"), ("A15", "INTEGER"), ("A16", "INTEGER"),
    ]),
    "loan": ("loan.csv", [
        ("loan_id", "INTEGER"), ("account_id", "INTEGER"), ("date", "TEXT"),
        ("amount", "INTEGER"), ("duration", "INTEGER"), ("payments", "REAL"),
        ("status", "TEXT"),
    ]),
    "order": ("order.csv", [
        ("order_id", "INTEGER"), ("account_id", "INTEGER"), ("bank_to", "TEXT"),
        ("account_to", "TEXT"), ("amount", "REAL"), ("k_symbol", "TEXT"),
    ]),
    "trans": ("trans.csv", [
        ("trans_id", "INTEGER"), ("account_id", "INTEGER"), ("date", "TEXT"),
        ("type", "TEXT"), ("operation", "TEXT"), ("amount", "REAL"),
        ("balance", "REAL"), ("k_symbol", "TEXT"), ("bank", "TEXT"), ("account", "TEXT"),
    ]),
}

INDEXES = [
    ("idx_account_district", "account", "district_id"),
    ("idx_card_disp", "card", "disp_id"),
    ("idx_client_district", "client", "district_id"),
    ("idx_disp_client", "disp", "client_id"),
    ("idx_disp_account", "disp", "account_id"),
    ("idx_loan_account", "loan", "account_id"),
    ("idx_order_account", "order", "account_id"),
    ("idx_trans_account", "trans", "account_id"),
    ("idx_trans_date", "trans", "date"),
]


def convert(value, sql_type):
    value = value.strip()
    if value in ("", "?"):
        return None
    if sql_type == "INTEGER":
        try:
            return int(value)
        except ValueError:
            return None
    if sql_type == "REAL":
        try:
            return float(value)
        except ValueError:
            return None
    return value


def load_table(conn, table, csv_name, columns):
    path = os.path.join(RAW_DIR, csv_name)
    col_defs = ", ".join(f'"{name}" {sql_type}' for name, sql_type in columns)
    conn.execute(f'DROP TABLE IF EXISTS "{table}"')
    conn.execute(f'CREATE TABLE "{table}" ({col_defs})')

    placeholders = ", ".join("?" for _ in columns)
    col_names = ", ".join(f'"{name}"' for name, _ in columns)
    insert_sql = f'INSERT INTO "{table}" ({col_names}) VALUES ({placeholders})'

    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.reader(f, delimiter=";")
        header = next(reader)
        assert len(header) == len(columns), (
            f"{csv_name}: expected {len(columns)} columns, got {len(header)}: {header}"
        )
        rows = []
        count = 0
        for row in reader:
            rows.append(tuple(convert(v, columns[i][1]) for i, v in enumerate(row)))
            if len(rows) >= 20000:
                conn.executemany(insert_sql, rows)
                count += len(rows)
                rows = []
        if rows:
            conn.executemany(insert_sql, rows)
            count += len(rows)
    print(f"  {table}: {count} rows")


def main():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)

    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode = WAL")
    print(f"Building {DB_PATH} ...")
    for table, (csv_name, columns) in TABLES.items():
        load_table(conn, table, csv_name, columns)

    print("Creating indexes ...")
    for idx_name, table, column in INDEXES:
        conn.execute(f'CREATE INDEX "{idx_name}" ON "{table}" ("{column}")')

    conn.commit()
    conn.close()
    print("Done.")


if __name__ == "__main__":
    main()
