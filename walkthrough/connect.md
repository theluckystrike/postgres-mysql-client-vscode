# Add a connection

- PostgreSQL: paste `postgres://user@host:5432/database?sslmode=require`, or fill in host, port, user and database.
- MySQL and MariaDB: paste `mysql://user@host:3306/database`.
- SQLite: pick the `.db` or `.sqlite` file.

Click "Test connection" first. The password is kept in VS Code's secret storage. Turn on "Read-only" for production databases: the server then refuses every change made on this connection.

You can add as many connections as you like. They are free, with no limit.
