import httpx

def platform_httpx_limits():
    return httpx.Limits(max_connections=20, max_keepalive_connections=5, keepalive_expiry=2)
