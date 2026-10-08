# PostGIS image + pgvector. The official postgres base already has the apt.postgresql.org repo configured.
ARG PG_MAJOR=18
ARG POSTGIS_VERSION=3.6
FROM postgis/postgis:${PG_MAJOR}-${POSTGIS_VERSION}

ARG PG_MAJOR
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-${PG_MAJOR}-pgvector \
 && rm -rf /var/lib/apt/lists/*

# Runs after the base image's own script that enables postgis (10_postgis.sh).
COPY 20_extensions.sql /docker-entrypoint-initdb.d/
