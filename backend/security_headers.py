"""Content-Security-Policy values, one per kind of response.

The app shell must never be framed, but the original course files are shown inside the
study workbench, so their responses allow framing by this same origin only.
"""

DEFAULT_CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; "
    "frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
)

# Kept minimal: stricter fetch directives can stop the browser's built-in PDF viewer.
MATERIAL_FILE_CSP = "frame-ancestors 'self'; base-uri 'none'"
