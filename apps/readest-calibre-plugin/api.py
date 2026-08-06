__license__ = 'AGPL v3'
__copyright__ = '2026, Bilingify LLC'

"""HTTP client + content hashes for the Readest cloud API.

Standard-library only (no calibre / Qt imports) so it can be unit-tested
outside calibre. The endpoints and shapes mirror the ones already consumed by
readest.koplugin (readest-sync-api.json) and served
by apps/readest-app/src/pages/api/.
"""

import base64
import hashlib
import json
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

DEFAULT_API_BASE = 'https://web.readest.com/api'

TIMEOUT = 30
UPLOAD_TIMEOUT = 600
# Servers cap this (100 at the time of writing) and report the size they
# actually served, so asking for more is free and pays off if the cap rises:
# the listing costs about a second per request regardless of rows returned.
LIST_PAGE_SIZE = 1000
# Page size for the books pull. A 10k-book library cannot come back in one
# response — serializing it exceeded the server's per-request resource limits
# (Cloudflare error 1102) — so pull_books walks bounded pages instead.
PULL_PAGE_SIZE = 1000


def _synced_at_ms(row):
    """Epoch ms of a row's synced_at (fallback updated_at); 0 when absent."""
    value = row.get('synced_at') or row.get('updated_at')
    if not isinstance(value, str) or not value:
        return 0
    try:
        dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return 0
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


class ReadestAPIError(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


class AuthRequiredError(ReadestAPIError):
    """No valid session — the user must log in."""


class QuotaExceededError(ReadestAPIError):
    """The server rejected an upload for insufficient storage quota."""


# ---------------------------------------------------------------------------
# Content hashes
# ---------------------------------------------------------------------------


def _partial_md5_ranges(size):
    """Chunk ranges of apps/readest-app/src/utils/md5.ts::partialMD5.

    1024-byte chunks at offsets 0, 1024, 4096, ..., 1024 << 20 (the JS loop
    runs i in -1..10; `1024 << -2` wraps to 0 under JS 32-bit shift).
    """
    ranges = []
    for i in range(-1, 11):
        offset = 0 if i == -1 else 1024 << (2 * i)
        start = min(size, offset)
        if start >= size:
            break
        ranges.append((start, min(start + 1024, size)))
    return ranges


def partial_md5(file_or_path, size=None):
    """Readest's Book.hash: partial MD5 of a file (KOReader-compatible)."""
    if isinstance(file_or_path, str):
        with open(file_or_path, 'rb') as f:
            f.seek(0, 2)
            return partial_md5(f, f.tell())
    f = file_or_path
    hasher = hashlib.md5()
    for start, end in _partial_md5_ranges(size):
        f.seek(start)
        hasher.update(f.read(end - start))
    return hasher.hexdigest()


def partial_md5_bytes(data):
    hasher = hashlib.md5()
    for start, end in _partial_md5_ranges(len(data)):
        hasher.update(data[start:end])
    return hasher.hexdigest()


def _normalize_identifier(identifier):
    # Mirrors utils/book.ts::normalizeIdentifier.
    if 'urn:' in identifier:
        return identifier.rsplit(':', 1)[-1]
    if ':' in identifier:
        return identifier.split(':', 1)[1]
    return identifier


def _identifiers_list(identifiers):
    # Mirrors utils/book.ts::getIdentifiersList / getPreferredIdentifier.
    if not identifiers:
        return []
    for scheme in ('uuid', 'calibre', 'isbn'):
        for identifier in identifiers:
            if scheme in identifier.lower():
                return [_normalize_identifier(identifier)]
    return [_normalize_identifier(i) for i in identifiers if i]


def meta_hash(title, authors, identifiers):
    """Readest's Book.metaHash: md5 over "title|authors|identifiers" (NFC).

    `identifiers` are raw identifier strings, scheme-prefixed where known
    (e.g. "urn:uuid:...", "isbn:...").
    """
    source = '%s|%s|%s' % (
        title or '',
        ','.join(authors or []),
        ','.join(_identifiers_list(identifiers)),
    )
    return hashlib.md5(unicodedata.normalize('NFC', source).encode('utf-8')).hexdigest()


# ---------------------------------------------------------------------------
# HTTP client
# ---------------------------------------------------------------------------


def _default_transport(request, timeout):
    """Returns (status, body, headers).

    Headers are part of the contract because Better Auth keeps the session in a
    cookie: signing in only tells you the credentials were good, and the thing
    you have to keep is in Set-Cookie.
    """
    try:
        with urllib.request.urlopen(request, timeout=timeout) as res:
            return res.status, res.read(), res.headers
    except urllib.error.HTTPError as err:
        return err.code, err.read(), err.headers


class ReadestClient:
    """Supabase auth + Readest sync/storage API client.

    tokens: dict with access_token / refresh_token / expires_at (epoch s) /
    expires_in (s), persisted through the on_tokens callback whenever they
    change. `transport(request, timeout) -> (status, body_bytes)` is
    injectable for tests.
    """

    def __init__(
        self,
        api_base=DEFAULT_API_BASE,
        tokens=None,
        on_tokens=None,
        transport=None,
    ):
        self.api_base = api_base.rstrip('/')
        self.tokens = dict(tokens) if tokens else None
        self.on_tokens = on_tokens
        self.transport = transport or _default_transport

    # -- plumbing -----------------------------------------------------------

    def _request(self, method, url, headers, body=None, timeout=TIMEOUT):
        data = None
        if body is not None:
            data = json.dumps(body).encode('utf-8')
            headers = dict(headers, **{'Content-Type': 'application/json'})
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        status, payload, response_headers = self.transport(request, timeout)
        parsed = None
        if payload:
            try:
                parsed = json.loads(payload.decode('utf-8'))
            except (ValueError, UnicodeDecodeError):
                parsed = None
        return status, parsed, payload, response_headers

    @staticmethod
    def _error_message(parsed, payload, fallback):
        if isinstance(parsed, dict):
            for key in ('error_description', 'msg', 'message', 'error'):
                value = parsed.get(key)
                if isinstance(value, str) and value:
                    return value
        if payload:
            return payload.decode('utf-8', 'replace')[:200]
        return fallback

    # -- Better Auth --------------------------------------------------------
    #
    # Two credentials, and they are not interchangeable. The session cookie is
    # what `/auth/*` accepts and what this client stores long-term; the JWT is
    # what every other route verifies against the JWKS, and it is minted from
    # the cookie on demand. There is no refresh token — a JWT that has expired
    # is replaced by asking for another one.

    @staticmethod
    def _session_cookie(headers):
        """The session cookie out of a Set-Cookie, or None."""
        if headers is None:
            return None
        values = headers.get_all('Set-Cookie') if hasattr(headers, 'get_all') else None
        if values is None:
            raw = headers.get('Set-Cookie') if hasattr(headers, 'get') else None
            values = [raw] if raw else []
        for value in values:
            pair = value.split(';')[0].strip()
            if pair.startswith('better-auth.session_token='):
                return pair
        return None

    @staticmethod
    def _jwt_expiry(token):
        """`exp` out of a JWT, or 0 when it cannot be read."""
        try:
            payload = token.split('.')[1]
            payload += '=' * (-len(payload) % 4)
            return int(json.loads(base64.urlsafe_b64decode(payload)).get('exp') or 0)
        except Exception:
            return 0

    def _store_tokens(self, access_token, session_cookie):
        self.tokens = {
            'access_token': access_token,
            'session_cookie': session_cookie,
            'expires_at': self._jwt_expiry(access_token),
        }
        if self.on_tokens:
            self.on_tokens(dict(self.tokens))

    def _cookie_headers(self):
        cookie = (self.tokens or {}).get('session_cookie')
        headers = {'Accept': 'application/json'}
        if cookie:
            headers['Cookie'] = cookie
        return headers

    def _mint_access_token(self, session_cookie):
        status, parsed, payload, _ = self._request(
            'GET',
            self.api_base + '/auth/token',
            {'Accept': 'application/json', 'Cookie': session_cookie},
        )
        if status != 200 or not isinstance(parsed, dict) or not parsed.get('token'):
            raise AuthRequiredError(
                self._error_message(parsed, payload, 'Could not obtain an access token'), status
            )
        return parsed['token']

    def sign_in_password(self, email, password):
        status, parsed, payload, headers = self._request(
            'POST',
            self.api_base + '/auth/sign-in/email',
            {'Accept': 'application/json'},
            body={'email': email, 'password': password},
        )
        if status != 200 or not isinstance(parsed, dict):
            raise ReadestAPIError(self._error_message(parsed, payload, 'Login failed'), status)
        cookie = self._session_cookie(headers)
        if not cookie:
            raise ReadestAPIError('Sign-in returned no session', status)
        self._store_tokens(self._mint_access_token(cookie), cookie)
        return parsed.get('user') or {}

    def refresh(self):
        cookie = (self.tokens or {}).get('session_cookie')
        if not cookie:
            raise AuthRequiredError('Not logged in')
        self._store_tokens(self._mint_access_token(cookie), cookie)

    def ensure_fresh_token(self):
        # Re-mint inside the last five minutes rather than on expiry: the JWT
        # lasts a week, so there is no reason to cut it fine, and a token that
        # expires mid-upload fails a long request for nothing.
        if not self.tokens or not self.tokens.get('access_token'):
            raise AuthRequiredError('Not logged in')
        if (self.tokens.get('expires_at') or 0) < time.time() + 300:
            self.refresh()

    def get_user(self):
        status, parsed, payload, _ = self._request(
            'GET', self.api_base + '/auth/get-session', self._cookie_headers()
        )
        user = parsed.get('user') if isinstance(parsed, dict) else None
        if status != 200 or not user:
            raise AuthRequiredError(self._error_message(parsed, payload, 'Not logged in'), status)
        return user

    def sign_out(self):
        if self.tokens and self.tokens.get('session_cookie'):
            try:
                self._request(
                    'POST', self.api_base + '/auth/sign-out', self._cookie_headers(), body={}
                )
            except Exception:
                pass  # best-effort; local tokens are cleared regardless
        self.tokens = None
        if self.on_tokens:
            self.on_tokens(None)

    # -- Readest API --------------------------------------------------------

    def _api(self, method, path, body=None):
        self.ensure_fresh_token()
        headers = {
            'Authorization': 'Bearer ' + self.tokens['access_token'],
            'Accept': 'application/json',
        }
        status, parsed, payload, _ = self._request(method, self.api_base + path, headers, body=body)
        if status in (401, 403):
            message = self._error_message(parsed, payload, 'Not authenticated')
            if 'quota' in message.lower():
                raise QuotaExceededError(message, status)
            raise AuthRequiredError(message, status)
        if status != 200:
            raise ReadestAPIError(
                self._error_message(parsed, payload, 'Request failed (%s)' % status), status
            )
        return parsed

    def pull_books(self, since=0):
        """All book rows changed since `since` (epoch ms), pulled in pages.

        The server returns each page ordered by synced_at ascending and
        completed to the trailing timestamp, so advancing the cursor to the
        newest row seen and re-asking never skips rows; the millisecond-
        truncated cursor can re-return boundary rows, deduped here with
        last-wins. A page shorter than the limit — or a cursor that cannot
        advance — means the delta is exhausted. A server that ignores `limit`
        returns everything at once and the follow-up page comes back empty.
        """
        by_key = {}
        cursor = since
        while True:
            result = self._api(
                'GET', '/sync?type=books&since=%d&limit=%d' % (cursor, PULL_PAGE_SIZE)
            )
            rows = (result or {}).get('books') or []
            max_ms = cursor
            for row in rows:
                by_key[row.get('book_hash') or row.get('id')] = row
                max_ms = max(max_ms, _synced_at_ms(row))
            if len(rows) < PULL_PAGE_SIZE or max_ms <= cursor:
                break
            cursor = max_ms
        return list(by_key.values())

    def push_books(self, records):
        return self._api('POST', '/sync', body={'books': records, 'notes': [], 'configs': []})

    def get_upload_url(self, file_name, file_size, book_hash):
        return self._api(
            'POST',
            '/storage/upload',
            body={'fileName': file_name, 'fileSize': file_size, 'bookHash': book_hash},
        )

    def list_files(self, book_hash):
        result = self._api('GET', '/storage/list?bookHash=' + urllib.parse.quote(book_hash))
        return (result or {}).get('files') or []

    def list_files_page(self, page):
        """(files, total_pages) for one page of the whole-account listing.

        `total_pages` reflects the page size the server actually served, so
        paging stays correct whether or not it honoured LIST_PAGE_SIZE.
        """
        result = (
            self._api('GET', '/storage/list?page=%d&pageSize=%d' % (page, LIST_PAGE_SIZE)) or {}
        )
        return (result.get('files') or []), (result.get('totalPages') or 0)

    def list_all_files(self):
        """Every stored file for the user, following the endpoint's paging.

        Pagination is driven by `totalPages`, not by the batch length: the
        endpoint pads each page with the other files of any book it touched,
        so a batch can be larger than `pageSize`.
        """
        files, total_pages = self.list_files_page(1)
        for page in range(2, total_pages + 1):
            more, _ = self.list_files_page(page)
            files.extend(more)
        return files

    def delete_file(self, file_key):
        return self._api(
            'DELETE', '/storage/delete?fileKey=' + urllib.parse.quote(file_key, safe='')
        )

    def put_file(self, url, fileobj, size):
        """PUT raw bytes to a presigned URL (no auth headers)."""
        request = urllib.request.Request(
            url,
            data=fileobj,
            headers={'Content-Length': str(size)},
            method='PUT',
        )
        status, payload, _ = self.transport(request, UPLOAD_TIMEOUT)
        if status not in (200, 201, 204):
            message = 'Upload failed (%s)' % status
            if payload:
                # S3/R2 error responses are XML; surface the <Code> tag.
                text = payload.decode('utf-8', 'replace')
                start, end = text.find('<Code>'), text.find('</Code>')
                if 0 <= start < end:
                    message += ': ' + text[start + 6 : end]
            raise ReadestAPIError(message, status)
