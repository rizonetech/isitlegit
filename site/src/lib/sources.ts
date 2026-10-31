// Every external figure and quote on the marketing site, with the primary source it was read from (D07 T06 §2; the
// writing rules: every figure sourced). Read from the publishers' own PDFs on 2026-10-31; the site lane's run file
// records what each page holds. The tests check each figure appears on its page beside its source link.
export type Source = { title: string; publisher: string; url: string; published: string; read: string };

export const SABRIC_2025: Source = {
  title: "Annual Crime Statistics 2025",
  publisher: "South African Banking Risk Information Centre (SABRIC)",
  url: "https://www.sabric.co.za/wp-content/uploads/2026/08/SABRIC-Annual-Crime-Statistics-Report-2025.pdf",
  published: "2026-08-04",
  read: "2026-10-31",
};

export const IC3_2025: Source = {
  title: "2025 IC3 Annual Report",
  publisher: "FBI Internet Crime Complaint Center (IC3)",
  url: "https://www.ic3.gov/AnnualReport/Reports/2025_IC3Report.pdf",
  published: "2026-04-16",
  read: "2026-10-31",
};

export const INTERPOL_AFRICA_2025: Source = {
  title: "Africa Cyberthreat Assessment Report 2025",
  publisher: "INTERPOL",
  url: "https://www.interpol.int/content/download/23094/file/Cybercrime_Africa%20Cyberthreat%20Assessment%20Report_Design_FINAL.pdf",
  published: "2025-06-23",
  read: "2026-10-31",
};

export type Figure = { text: string; source: Source; page: string; note: string };

// The figures as the home page prints them. `text` is the exact string on the page.
export const homeFigures: readonly Figure[] = [
  { text: "R2.4 billion", source: SABRIC_2025, page: "3 and 7", note: "client claims in 2025 (R2,406,728,972)" },
  { text: "29.2%", source: SABRIC_2025, page: "3 and 7", note: "up from R1.86 billion in 2024" },
  { text: "110,074", source: SABRIC_2025, page: "7", note: "incidents in 2025" },
  { text: "52,588", source: SABRIC_2025, page: "7", note: "incidents in 2023" },
  { text: "R21,865", source: SABRIC_2025, page: "7", note: "average loss per incident in 2025" },
  { text: "US$3 billion", source: IC3_2025, page: "8, 9 and 26", note: "BEC losses US$3,046,598,558 in 2025" },
  { text: "24,768", source: IC3_2025, page: "25", note: "BEC complaints in 2025" },
];

export const SABRIC_QUOTE =
  "In business environments, supplier mandate fraud and business email compromise remained material risks. Criminals redirected payments through fraudulent changes to banking details, falsified supplier information, or compromised communications.";
export const INTERPOL_QUOTE = "organizations of all sizes, from small and medium-sized enterprises to large corporations";
