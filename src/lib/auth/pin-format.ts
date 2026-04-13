import { PIN_LENGTH } from '@/constants/auth';

const PIN_REGEX = new RegExp(`^\\d{${PIN_LENGTH}}$`);

export function isValidPinFormat(pin: string): boolean {
  return PIN_REGEX.test(pin);
}
