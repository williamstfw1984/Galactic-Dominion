"use strict";
/* The suicide and crisis helpline shown on the help screen for each country, with the country's emergency number. Each
   is the top-ranked helpline for suicidal thoughts on findahelpline.com, which lists when it last verified it.
   code: the country's ISO 3166-1 code, as Windows' region setting gives it. text: a number to text, when there is one.
   always: whether it is open at all hours. */
(function (api) {
  if (typeof module === "object") module.exports = api; else globalThis.Helplines = api;
})((() => {
  const HELPLINES = [
    {"code": "AR", "country": "Argentina", "name": "Centro de Asistencia al Suicida", "phone": "0800 345 1435", "text": "", "always": false, "emergency": "911"},   // verified 2026-03-06
    {"code": "AT", "country": "Austria", "name": "Telefonseelsorge – Notruf 142", "phone": "142", "text": "", "always": true, "emergency": "112"},   // verified 2026-06-22
    {"code": "AU", "country": "Australia", "name": "Lifeline", "phone": "13 11 14", "text": "0477 13 11 14", "always": true, "emergency": "000"},   // verified 2026-07-09
    {"code": "BE", "country": "Belgium", "name": "Zelfmoordlijn 1813", "phone": "1813", "text": "", "always": true, "emergency": "112"},   // verified 2026-09-09
    {"code": "BR", "country": "Brazil", "name": "CVV - Centro de Valorização da Vida", "phone": "188", "text": "", "always": true, "emergency": "192"},   // verified 2026-02-25
    {"code": "CA", "country": "Canada", "name": "9-8-8: Suicide Crisis Helpline", "phone": "988", "text": "988", "always": true, "emergency": "911"},   // verified 2026-07-30
    {"code": "CH", "country": "Switzerland", "name": "143.ch - Die Dargebotene Hand", "phone": "143", "text": "", "always": true, "emergency": "144"},   // verified 2026-03-02
    {"code": "DE", "country": "Germany", "name": "TelefonSeelsorge", "phone": "0800 111 0 111", "text": "", "always": true, "emergency": "112"},   // verified 2026-10-22
    {"code": "DK", "country": "Denmark", "name": "Livslinien", "phone": "70 201 201", "text": "", "always": false, "emergency": "112"},   // verified 2026-02-20
    {"code": "ES", "country": "Spain", "name": "024", "phone": "024", "text": "", "always": true, "emergency": "112"},   // verified 2026-10-26
    {"code": "FI", "country": "Finland", "name": "MIELI Kriisipuhelin", "phone": "09 2525 0111", "text": "", "always": true, "emergency": "112"},   // verified 2026-03-29
    {"code": "FR", "country": "France", "name": "3114 - Numéro national de prévention du suicide", "phone": "3114", "text": "", "always": true, "emergency": "112"},   // verified 2026-11-04
    {"code": "GB", "country": "United Kingdom", "name": "Samaritans Helpline", "phone": "116 123", "text": "", "always": true, "emergency": "999"},   // verified 2026-09-17
    {"code": "IE", "country": "Ireland", "name": "Pieta 24 hour crisis helpline", "phone": "1800 247 247", "text": "51444", "always": true, "emergency": "112"},   // verified 2026-07-23
    {"code": "IL", "country": "Israel", "name": "ער\"ן - עזרה ראשונה נפשית", "phone": "1201", "text": "0529993544", "always": true, "emergency": "101"},   // verified 2026-11-04
    {"code": "IN", "country": "India", "name": "Tele MANAS", "phone": "14416", "text": "", "always": true, "emergency": "112"},   // verified 2026-07-17
    {"code": "IT", "country": "Italy", "name": "Telefono Amico Italia", "phone": "02 2327 2327", "text": "", "always": true, "emergency": "112"},   // verified 2026-06-18
    {"code": "JP", "country": "Japan", "name": "＃いのちSOS", "phone": "0120 061 338", "text": "", "always": true, "emergency": "119"},   // verified 2026-04-07
    {"code": "KR", "country": "South Korea", "name": "자살예방상담전화 109", "phone": "109", "text": "", "always": true, "emergency": "119"},   // verified 2026-08-20
    {"code": "MX", "country": "Mexico", "name": "Línea de la Vida", "phone": "800 911 2000", "text": "", "always": true, "emergency": "911"},   // verified 2025-06-27
    {"code": "NL", "country": "Netherlands", "name": "113 Zelfmoordpreventie", "phone": "113", "text": "", "always": true, "emergency": "112"},   // verified 2026-09-28
    {"code": "NO", "country": "Norway", "name": "Mental Helse", "phone": "116 123", "text": "", "always": true, "emergency": "113"},   // verified 2026-10-28
    {"code": "NZ", "country": "New Zealand", "name": "1737 Need to talk?", "phone": "1737", "text": "1737", "always": true, "emergency": "111"},   // verified 2026-09-08
    {"code": "PH", "country": "Philippines", "name": "NCMH Crisis Hotline", "phone": "1553", "text": "", "always": true, "emergency": "911"},   // verified 2026-11-05
    {"code": "PL", "country": "Poland", "name": "Olsztyńskie Stowarzyszenie Pomocy Telefoniczej (Olsztyn Telephone Emergency Help Association)", "phone": "+48 89 527 00 00", "text": "", "always": true, "emergency": "112"},   // verified 2026-10-28
    {"code": "PT", "country": "Portugal", "name": "Linha de Prevenção do Suicídio e Apoio Psicológico - 1411", "phone": "1411", "text": "", "always": true, "emergency": "112"},   // verified 2025-10-02
    {"code": "SE", "country": "Sweden", "name": "Mind Självmordslinjen", "phone": "90101", "text": "", "always": true, "emergency": "112"},   // verified 2025-01-08
    {"code": "SG", "country": "Singapore", "name": "national mindline 1771", "phone": "1771", "text": "", "always": true, "emergency": "995"},   // verified 2026-09-01
    {"code": "US", "country": "United States", "name": "988 Suicide & Crisis Lifeline", "phone": "988", "text": "988", "always": true, "emergency": "911"},   // verified 2026-10-22
    {"code": "ZA", "country": "South Africa", "name": "Suicide Crisis Line", "phone": "0800 567 567", "text": "", "always": true, "emergency": "112"}    // verified 2026-05-13
  ];
  const elsewhere = "findahelpline.com";             // where the helplines of every other country are listed
  return { list: HELPLINES, of: code => HELPLINES.find(line => line.code === String(code || "").toUpperCase()) || null, elsewhere };
})());
