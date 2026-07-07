# To update the pins, run:
# docker run --rm postgres:18.4-trixie bash -c "apt-get update -qq && apt-cache madison postgresql-18 postgresql-18-postgis-3 postgresql-18-wal2json"

FROM postgres:18.4-trixie

ENV PG_VERSION=18.4-1.pgdg13+1
ENV POSTGIS_VERSION=3.6.4+dfsg-2.pgdg13+1
ENV WAL2JSON_VERSION=2.6-3.pgdg13+1

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    postgresql-${PG_MAJOR}=${PG_VERSION} \
    postgresql-${PG_MAJOR}-postgis-3=${POSTGIS_VERSION} \
    postgresql-${PG_MAJOR}-postgis-3-scripts=${POSTGIS_VERSION} \
    postgresql-${PG_MAJOR}-wal2json=${WAL2JSON_VERSION} \
  && rm -rf /var/lib/apt/lists/*