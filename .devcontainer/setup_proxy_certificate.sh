#!/usr/bin/env bash
# =============================================================================
# install-corp-cert.sh
# Install corporate proxy certificates into the system trust store.
#
# Two-phase approach:
#   1. Install the bundled root CA certificate (zscaler-root.crt) if present.
#   2. Probe the proxy endpoint to capture the leaf/intermediate certificate
#      that the TLS-intercepting proxy presents to clients.
#
# Can be called from:
#   - Containerfile RUN step (during image build, as root)
#   - devcontainer lifecycle scripts (as vscode user, uses sudo)
#
# Skips gracefully if certs are already installed or proxy is unreachable.
# =============================================================================

CERT_STORE="/usr/local/share/ca-certificates"
PROXY_HOSTS=("zscaler.com")

_sudo() {
    if [[ "$(id -u)" -eq 0 ]]; then
        "$@"
    else
        sudo "$@"
    fi
}

# Phase 1: Install bundled root CA certificate
_install_bundled_cert() {
    local script_dir root_cert
    script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
    root_cert="${script_dir}/zscaler-root.crt"

    if [[ ! -f "${root_cert}" ]]; then
        echo "No bundled root certificate found (${root_cert}), skipping phase 1" >&2
        return 1
    fi

    if [[ -f "${CERT_STORE}/zscaler-root.crt" ]]; then
        echo "Bundled root certificate already installed, skipping" >&2
        return 0
    fi

    _sudo cp "${root_cert}" "${CERT_STORE}/zscaler-root.crt"
    echo "Installed bundled root certificate to ${CERT_STORE}/zscaler-root.crt" >&2
}

# Phase 2: Probe proxy and install leaf/intermediate certificate
_install_probed_cert() {
    local host="$1"
    local cert_name="${host%:*}"
    cert_name="${cert_name%%.*}"
    local cert_file="${CERT_STORE}/${cert_name}.crt"

    if [[ -f "${cert_file}" ]]; then
        echo "Probed certificate for '${host}' already installed (${cert_file}), skipping" >&2
        return 0
    fi

    echo "Probing for proxy certificate from '${host}'..." >&2

    local cert_raw cert
    if ! cert_raw=$(timeout 5 openssl s_client -showcerts -connect "${host}:443" \
        -servername "${host}" </dev/null 2>/dev/null); then
        cert_raw=""
    fi
    cert=$(awk '/BEGIN CERTIFICATE/{c=""} {c=c $0 ORS} /END CERTIFICATE/{last=c} END{printf "%s", last}' <<< "${cert_raw}")

    if [[ -z "${cert}" ]]; then
        echo "No certificate retrieved from '${host}', skipping" >&2
        return 1
    fi

    if ! echo "${cert}" | openssl x509 -noout -issuer 2>/dev/null; then
        echo "Retrieved invalid certificate from '${host}', skipping" >&2
        return 1
    fi

    echo "${cert}" | _sudo tee "${cert_file}" > /dev/null
    echo "Installed probed certificate from '${host}' to ${cert_file}" >&2
}

install_corp_certs() {
    local updated=0

    # Phase 1: bundled root cert
    if _install_bundled_cert; then
        updated=1
    fi

    # Phase 2: probed leaf certs
    for host in "${PROXY_HOSTS[@]}"; do
        if _install_probed_cert "${host}"; then
            updated=1
        fi
    done

    if [[ "${updated}" -eq 1 ]]; then
        _sudo update-ca-certificates
        echo "CA trust store updated" >&2
    else
        echo "No new certificates installed, skipping CA update" >&2
    fi
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    install_corp_certs
fi
