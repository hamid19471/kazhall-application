export const AddressMessages = {
  ADDRESS_CREATED: 'Address created successfully',
  ADDRESS_DELETED: 'Address deleted successfully',
  ADDRESS_UPDATED: 'Address updated successfully',
  ADDRESS_NOT_FOUND: 'Address not found',
  /**
   * Deliberately identical to ADDRESS_NOT_FOUND and returned with the same 404.
   * Answering "that address exists but is not yours" with a 403 would turn the
   * endpoint into an oracle for enumerating other customers' address ids. The
   * distinction is kept in the server log, not in the response.
   */
  ADDRESS_NOT_OWNED: 'Address not found',
} as const;
