# Cloudflare in front of everything: CDN, TLS, DDoS protection, firewall (WAF) and rate limits.
# The managed WAF rulesets need a Pro plan or higher; set enable_managed_waf = false on Free.
#
#   export CLOUDFLARE_API_TOKEN=...   (Zone: DNS, Zone Settings, Zone WAF, Cache Rules – Edit)
#   terraform init && terraform apply -var zone_id=... -var domain=example.com -var origin_ip=LOAD_BALANCER_IP

terraform {
  required_version = ">= 1.6"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.40"
    }
  }
}

provider "cloudflare" {}

variable "zone_id" {
  type        = string
  description = "Cloudflare zone ID of the domain."
}

variable "domain" {
  type        = string
  description = "Root domain, e.g. example.com. The apps live at api., app. and dashboard."
}

variable "origin_ip" {
  type        = string
  description = "Public IP of the cluster's ingress load balancer."
}

variable "enable_managed_waf" {
  type        = bool
  default     = true
  description = "Cloudflare and OWASP managed rules (Pro plan and above)."
}

locals {
  hosts    = toset(["api", "app", "dashboard"])
  api_host = "api.${var.domain}"
}

# --- DNS: every host goes through Cloudflare (proxied), so the origin address stays hidden. ---
resource "cloudflare_record" "app" {
  for_each = local.hosts
  zone_id  = var.zone_id
  name     = each.key
  type     = "A"
  content  = var.origin_ip
  proxied  = true
  ttl      = 1
}

# --- TLS and transport ---
resource "cloudflare_zone_settings_override" "zone" {
  zone_id = var.zone_id
  settings {
    ssl                      = "strict" # Cloudflare checks the origin's certificate
    always_use_https         = "on"
    min_tls_version          = "1.2"
    tls_1_3                  = "on"
    automatic_https_rewrites = "on"
    http3                    = "on"
    brotli                   = "on"
    browser_check            = "on"
    security_header {
      enabled            = true
      max_age            = 31536000
      include_subdomains = true
      preload            = true
      nosniff            = true
    }
  }
}

# --- CDN: what the edge may cache ---
resource "cloudflare_ruleset" "cache" {
  zone_id = var.zone_id
  name    = "SSS cache rules"
  kind    = "zone"
  phase   = "http_request_cache_settings"

  # The API is personal data and live state: never cached.
  rules {
    description = "Never cache the API"
    expression  = "(http.host eq \"${local.api_host}\")"
    action      = "set_cache_settings"
    action_parameters {
      cache = false
    }
  }

  # The service worker must always be fresh, or fixes never reach installed apps.
  rules {
    description = "Never cache the service worker"
    expression  = "(http.request.uri.path eq \"/sw.js\")"
    action      = "set_cache_settings"
    action_parameters {
      cache = false
    }
  }

  # Next.js build assets carry a content hash in the name: cache for a year.
  rules {
    description = "Cache hashed build assets for a year"
    expression  = "(starts_with(http.request.uri.path, \"/_next/static/\"))"
    action      = "set_cache_settings"
    action_parameters {
      cache = true
      edge_ttl {
        mode    = "override_origin"
        default = 31536000
      }
      browser_ttl {
        mode    = "override_origin"
        default = 31536000
      }
    }
  }
}

# --- Firewall: custom rules ---
resource "cloudflare_ruleset" "firewall" {
  zone_id = var.zone_id
  name    = "SSS firewall"
  kind    = "zone"
  phase   = "http_request_firewall_custom"

  rules {
    description = "Block scanners probing for files this stack never serves"
    expression  = "(http.request.uri.path contains \"/.env\") or (http.request.uri.path contains \"/.git\") or (http.request.uri.path contains \"/wp-\") or (ends_with(http.request.uri.path, \".php\"))"
    action      = "block"
  }

  rules {
    description = "Dev tools are never reachable from the internet"
    expression  = "(http.host eq \"${local.api_host}\" and starts_with(http.request.uri.path, \"/dev\"))"
    action      = "block"
  }

  rules {
    description = "Challenge requests with a high threat score on the staff dashboard"
    expression  = "(http.host eq \"dashboard.${var.domain}\" and cf.threat_score gt 20)"
    action      = "managed_challenge"
  }
}

# --- Rate limits: sign-in and item checks are the abuse targets ---
resource "cloudflare_ruleset" "ratelimit" {
  zone_id = var.zone_id
  name    = "SSS rate limits"
  kind    = "zone"
  phase   = "http_ratelimit"

  rules {
    description = "Sign-in and one-time codes: 10 a minute per address"
    expression  = "(http.host eq \"${local.api_host}\" and starts_with(http.request.uri.path, \"/auth\"))"
    action      = "block"
    ratelimit {
      characteristics     = ["cf.colo.id", "ip.src"]
      period              = 60
      requests_per_period = 10
      mitigation_timeout  = 600
    }
  }

  rules {
    description = "Whole API: 300 a minute per address"
    expression  = "(http.host eq \"${local.api_host}\")"
    action      = "block"
    ratelimit {
      characteristics     = ["cf.colo.id", "ip.src"]
      period              = 60
      requests_per_period = 300
      mitigation_timeout  = 60
    }
  }
}

# --- Firewall: managed rules (Cloudflare's own + OWASP core) ---
resource "cloudflare_ruleset" "managed_waf" {
  count   = var.enable_managed_waf ? 1 : 0
  zone_id = var.zone_id
  name    = "SSS managed WAF"
  kind    = "zone"
  phase   = "http_request_firewall_managed"

  rules {
    description = "Cloudflare managed ruleset"
    expression  = "true"
    action      = "execute"
    action_parameters {
      id = "efb7b8c949ac4650a09736fc376e9aee"
    }
  }

  rules {
    description = "OWASP core ruleset"
    expression  = "true"
    action      = "execute"
    action_parameters {
      id = "4814384a9e5d4991b9815dcfc25d2f1f"
    }
  }
}
