# Edit rows safely

1. Click a table in the Database Explorer, or run `SELECT * FROM table`.
2. Double-click a cell and type. Use "+ Row" to add a row, and "Delete" to remove the selected rows.
3. Click "Review changes". You see the exact SQL, for example `UPDATE "public"."film" SET "title" = '...' WHERE "film_id" = '1'`.
4. Click "Save in one transaction". If any statement does not change exactly one row, nothing is saved.

Tables without a primary key stay read-only, because the grid cannot tell their rows apart.

"Export" writes every row, not only the loaded ones, to CSV, JSON or SQL INSERT. Rows stream to the file, so millions of rows are fine.
