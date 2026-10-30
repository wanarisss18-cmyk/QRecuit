// Thai national ID: 13 digits, last digit is a mod-11 checksum of the first 12.
export function isValidThaiId(value) {
  const id = String(value || '').replace(/\D/g, '');
  if (id.length !== 13) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(id[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(id[12]);
}

// 1-2345-67890-12-1 — how the number is printed on the card
export function formatThaiId(value) {
  const id = String(value || '');
  return id.length === 13 ? `${id[0]}-${id.slice(1, 5)}-${id.slice(5, 10)}-${id.slice(10, 12)}-${id[12]}` : id;
}

// 1-2345-xxxxx-xx-3 — what staff-role users see
export function maskThaiId(value) {
  const id = String(value || '');
  if (id.length !== 13) return id ? 'xxxxxxxxxxxxx' : '';
  return `${id[0]}-${id.slice(1, 5)}-xxxxx-xx-${id[12]}`;
}
