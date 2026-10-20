import { escapeCsvCell, toCsvLine } from "../utils/csv";

describe("CSV serialization", () => {
  it("renders plain values without quoting", () => {
    expect(escapeCsvCell("abc")).toBe("abc");
    expect(escapeCsvCell(42)).toBe("42");
  });

  it("renders null and undefined as empty cells", () => {
    expect(escapeCsvCell(null)).toBe("");
    expect(escapeCsvCell(undefined)).toBe("");
  });

  it("quotes values containing commas, quotes or line breaks", () => {
    expect(escapeCsvCell("a,b")).toBe('"a,b"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell("line1\nline2")).toBe('"line1\nline2"');
  });

  it("neutralizes spreadsheet formula prefixes", () => {
    expect(escapeCsvCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(escapeCsvCell("+1+1")).toBe("'+1+1");
    expect(escapeCsvCell("@SUM(A1)")).toBe("'@SUM(A1)");
  });

  it("serializes dates as ISO-8601", () => {
    expect(escapeCsvCell(new Date("2026-01-02T03:04:05.000Z"))).toBe("2026-01-02T03:04:05.000Z");
  });

  it("terminates each row with CRLF", () => {
    expect(toCsvLine(["a", 1, null, "b,c"])).toBe('a,1,,"b,c"\r\n');
  });
});
