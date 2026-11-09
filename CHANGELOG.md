# Changelog

## 0.2.0 (2026-11-10)

- Zovo Pro: Explain Plan and Explain Analyze. The plan of the statement at the cursor as a tree with cost or time bars, the slowest step marked and plain hints (full scan of a filtered table, sort spilled to disk, no index used, row estimate 10 times off). PostgreSQL, MySQL 8, MariaDB (`ANALYZE FORMAT=JSON`) and SQLite. Ctrl+Alt+E (Cmd+Alt+E on macOS). Explain Analyze runs only read-only queries.
- Zovo Pro: Compare Table Data. Two tables on any two connections, matched by primary key and read as a stream in key order. A report of equal, changed and missing rows, and a SQL script (opened, never run for you) that makes the second table match the first.
- Each Pro tool has 3 free tries, and the status bar now says which try it was. Everything that was free stays free.
- Rating ask v2.2: a window that stays open all week counts a new session after 4 hours. In Cursor, Windsurf, VSCodium and other editors that install from Open VSX, "Rate it" and the footer Rate link open the Open VSX review page.

## 0.1.0

- First release: PostgreSQL, MySQL, MariaDB and SQLite connections, Database Explorer, query editor with Ctrl+Enter, results grid, free row editing, streamed export to CSV, JSON and SQL INSERT, Cancel, read-only connections and query history.
- Zovo Pro (USD 19 once): ER diagram, schema compare, CSV import and a query library, each with 3 free tries. The setting `zovoSql.showProFeatures` hides them.
