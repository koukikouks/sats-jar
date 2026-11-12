//! The jar's picture: an SVG drawn from the jar's state on every view (ADR 0005). Pure, no I/O.

/// The fill's height when the jar is full: it rises from y = 250 to at most y = 70.
const FULL: u64 = 180;
const BOTTOM: u64 = 250;
/// The picture shows at most this many characters of the nickname.
const NICKNAME_CHARS: usize = 24;
/// The jar is full at a year of allowances at the cap.
const PERIODS_TO_FILL: u64 = 12;

/// What the picture shows.
pub struct Picture {
    pub nickname: String,
    /// Sats.
    pub balance: u64,
    /// Sats.
    pub cap: u64,
    /// Unix seconds.
    pub unlock_at: u64,
    /// Unix seconds, from `Jar::allowance_at` as `get_jar` shows it; none before the first
    /// top-up.
    pub next_allowance_at: Option<u64>,
    /// Unix seconds: when the picture is drawn.
    pub now: u64,
}

/// The picture as an SVG document.
pub fn render(picture: &Picture) -> String {
    let fill = fill(picture.balance, picture.cap);
    format!(
        concat!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 340">"#,
            r##"<rect width="200" height="340" fill="#fdf6e3"/>"##,
            r##"<text id="nickname" x="100" y="34" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#3b3b3b">{nickname}</text>"##,
            r##"<rect x="60" y="48" width="80" height="16" rx="4" fill="#b58900"/>"##,
            r##"<rect id="fill" x="30" y="{fill_y}" width="140" height="{fill}" fill="#f7931a"/>"##,
            r##"<rect x="30" y="64" width="140" height="190" rx="18" fill="none" stroke="#3b3b3b" stroke-width="6"/>"##,
            r##"<text id="balance" x="100" y="282" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#3b3b3b">{balance} sats</text>"##,
            r##"<text id="unlock" x="100" y="304" text-anchor="middle" font-family="sans-serif" font-size="13" fill="#6b6b6b">Unlocks {unlock}</text>"##,
            r##"<text id="next_allowance" x="100" y="326" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#6b6b6b">{next}</text>"##,
            "</svg>"
        ),
        nickname = nickname(&picture.nickname),
        fill_y = BOTTOM - fill,
        fill = fill,
        balance = sats(picture.balance),
        unlock = date(picture.unlock_at),
        next = next_allowance(picture.next_allowance_at, picture.now),
    )
}

/// The next allowance line: minutes matter under demo timing, so the time is shown too.
fn next_allowance(at: Option<u64>, now: u64) -> String {
    match at {
        None => "Allowance starts at first top-up".to_owned(),
        Some(at) if at <= now => "Allowance due now".to_owned(),
        Some(at) => format!(
            "Next allowance {} {:02}:{:02} UTC",
            date(at),
            at % 86_400 / 3_600,
            at % 3_600 / 60
        ),
    }
}

/// The nickname as SVG text: cut to 24 characters first (cutting after escaping could split an
/// entity), then without the characters XML 1.0 forbids, then escaped, so a giver's nickname can
/// never add markup to the picture.
fn nickname(raw: &str) -> String {
    let mut out = String::new();
    for c in raw.chars().take(NICKNAME_CHARS) {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            '\t' | '\n' | '\r' => out.push(c),
            '\u{0}'..='\u{1f}' | '\u{fffe}' | '\u{ffff}' => {}
            c => out.push(c),
        }
    }
    out
}

/// The fill's height: in proportion to the balance, full at a year of allowances, and never
/// zero while the jar holds anything.
fn fill(balance: u64, cap: u64) -> u64 {
    let full = u128::from(cap) * u128::from(PERIODS_TO_FILL);
    let height = (u128::from(balance) * u128::from(FULL) / full.max(1)).min(u128::from(FULL));
    match u64::try_from(height).unwrap_or(FULL) {
        0 if balance > 0 => 1,
        height => height,
    }
}

/// Sats with thousands separators: `250,000`.
pub fn sats(amount: u64) -> String {
    let digits = amount.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, digit) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// A unix time's UTC date as `YYYY-MM-DD` (Howard Hinnant's `civil_from_days`, integers only).
pub fn date(unix: u64) -> String {
    let z = unix / 86_400 + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + u64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}
