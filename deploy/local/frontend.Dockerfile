FROM ghcr.io/media-marshal/media-marshal-portal@sha256:d463d3bcf05829f2308408e4574943cf71e7f31fa9095209948ea2cff57c04cf
COPY dist/ /usr/share/nginx/html/
COPY nginx.conf /etc/nginx/conf.d/default.conf
