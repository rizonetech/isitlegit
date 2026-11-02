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

// The invoice fraud page's extra SABRIC figures and quote, and the FBI loss figure in full (D07 T06 §3).
export const invoiceFigures: readonly Figure[] = [
  { text: "R2.4 billion", source: SABRIC_2025, page: "3 and 7", note: "client claims in 2025" },
  { text: "29.2%", source: SABRIC_2025, page: "3 and 7", note: "up on 2024" },
  { text: "R1.9 billion", source: SABRIC_2025, page: "3", note: "about R1.9 billion in 2024 (R1.86 billion in the page 7 table)" },
  { text: "R1.09 billion", source: SABRIC_2025, page: "7", note: "client claims in 2023" },
  { text: "110,074", source: SABRIC_2025, page: "7", note: "incidents in 2025" },
  { text: "97,547", source: SABRIC_2025, page: "7", note: "incidents in 2024" },
  { text: "R21,865", source: SABRIC_2025, page: "7", note: "average loss per incident in 2025" },
  { text: "24,768", source: IC3_2025, page: "25", note: "BEC complaints in 2025" },
  { text: "US$3,046,598,558", source: IC3_2025, page: "8, 9 and 26", note: "BEC losses in 2025" },
];

export const SABRIC_POP_QUOTE = "release goods based on falsified proof of payment";

// The already-paid recovery steps (D07 T06 §11): each step's primary source, read 2026-11-02.
export const SABRIC_STAY_SAFE: Source = {
  title: "How to Stay Safe",
  publisher: "South African Banking Risk Information Centre (SABRIC)",
  url: "https://www.sabric.co.za/how-to-stay-safe/",
  published: "2026-11-02",
  read: "2026-11-02",
};

export const SAPS_REPORT_CRIME: Source = {
  title: "Report a crime",
  publisher: "South African Police Service (SAPS)",
  url: "https://www.saps.gov.za/services/report_crime.php",
  published: "2026-11-02",
  read: "2026-11-02",
};

export const FBI_BEC: Source = {
  title: "Business Email Compromise",
  publisher: "Federal Bureau of Investigation (FBI)",
  url: "https://www.fbi.gov/how-we-can-help-you/common-frauds-and-scams/business-email-compromise",
  published: "2026-11-02",
  read: "2026-11-02",
};

// The vendors' own help pages for forwarding a message as an attachment, read 2026-10-31.
export const HELP = {
  outlookShortcuts: {
    title: "Keyboard shortcuts for Outlook",
    url: "https://support.microsoft.com/en-us/office/keyboard-shortcuts-for-outlook-3cdeb221-7ae5-4c1d-8c1d-9e63216c1efd",
  },
  outlookForward: {
    title: "Reply to or forward an email message",
    url: "https://support.microsoft.com/en-us/outlook/reply-to-or-forward-an-email-message",
  },
  outlookAttach: {
    title: "Add pictures or attach files to emails in Outlook",
    url: "https://support.microsoft.com/en-us/office/add-pictures-or-attach-files-to-emails-in-outlook-bdfafef5-792a-42b1-9a7b-84512d7de7fc",
  },
  gmailAttach: {
    title: "Forward emails as attachments in Gmail",
    url: "https://support.google.com/mail/answer/9261412",
  },
} as const;

// Privacy page references (D07 T06 §5), read 2026-10-31. The Act's own PDF could not be read, so POPIA is cited by
// section number in our own words and the Regulator's pages are linked.
export const META_API_TERMS: Source = {
  title: "Model API pricing and rate limits (Standard and Contributor modes)",
  publisher: "Meta",
  url: "https://dev.meta.ai/docs/pricing-rate-limits",
  published: "undated",
  read: "2026-10-26",
};
export const FIREWORKS_DATA: Source = {
  title: "Fireworks AI data handling",
  publisher: "Fireworks AI",
  url: "https://docs.fireworks.ai/guides/security_compliance/data_handling",
  published: "undated",
  read: "2026-10-31",
};
export const INFOREG_POPIA: Source = {
  title: "POPIA",
  publisher: "Information Regulator (South Africa)",
  url: "https://inforegulator.org.za/popia/",
  published: "undated",
  read: "2026-10-31",
};
export const INFOREG_COMPLAINTS: Source = {
  title: "Complaints",
  publisher: "Information Regulator (South Africa)",
  url: "https://inforegulator.org.za/complaints/",
  published: "undated",
  read: "2026-10-31",
};
