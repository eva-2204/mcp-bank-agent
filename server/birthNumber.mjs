// Датасет Berka охватывает 1993–1998 годы, поэтому "текущей датой" для расчёта
// возраста клиента считается конец периода наблюдений, а не реальная сегодняшняя дата.
export const DATASET_REFERENCE_DATE = "1999-01-01";

// birth_number кодирует дату рождения и пол: RRMMDD, у женщин к месяцу
// прибавлено 50 (см. раздел 2 ТЗ).
export function decodeBirthNumber(birthNumber) {
  const digits = String(birthNumber).trim().padStart(6, "0");
  if (!/^\d{6}$/.test(digits)) {
    throw new Error(`Некорректный birth_number: ${birthNumber}`);
  }
  const yy = parseInt(digits.slice(0, 2), 10);
  let month = parseInt(digits.slice(2, 4), 10);
  const day = parseInt(digits.slice(4, 6), 10);

  let gender = "male";
  if (month > 50) {
    gender = "female";
    month -= 50;
  }

  const year = 1900 + yy;
  const birthDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const age = calculateAge(birthDate, DATASET_REFERENCE_DATE);

  return { birthDate, gender, age, referenceDate: DATASET_REFERENCE_DATE };
}

export function calculateAge(birthDateIso, asOfIso) {
  const b = new Date(birthDateIso);
  const asOf = new Date(asOfIso);
  let age = asOf.getFullYear() - b.getFullYear();
  const monthDiff = asOf.getMonth() - b.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && asOf.getDate() < b.getDate())) {
    age -= 1;
  }
  return age;
}
