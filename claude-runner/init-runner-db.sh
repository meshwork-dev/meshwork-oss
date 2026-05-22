#!/bin/bash
set -e

# Meshwork Runner Database Initialization
# Mounted at /docker-entrypoint-initdb.d/02-init-runner-db.sh
# Runs as postgres superuser during first container startup

# Create runner role if it doesn't exist
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    DO \$\$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'runner') THEN
        CREATE ROLE runner WITH LOGIN PASSWORD '${RUNNER_DB_PASSWORD:-runner_secure_password}';
      END IF;
    END
    \$\$;
EOSQL

# Check if runner database exists, create if not
if ! psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" -lqt | cut -d \| -f 1 | grep -qw runner; then
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
        CREATE DATABASE runner OWNER runner;
EOSQL
    echo "Created 'runner' database"
else
    echo "'runner' database already exists"
fi

# Grant connect privileges
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    GRANT ALL PRIVILEGES ON DATABASE runner TO runner;
EOSQL
