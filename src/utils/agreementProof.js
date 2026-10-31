// The booking agreement UI reports what the customer actually saw and
// acknowledged (terms text, per-section acknowledgements). It arrives from the
// client, so it is normalised to a fixed shape and size-limited before it is
// stored as evidence. Authoritative facts (who signed, when, from where) are
// stamped server-side and are never taken from this object.

const ACK_KEYS = ['cancellation', 'terms', 'damage', 'finalConfirmation'];
const MAX_SECTIONS = 10;
const MAX_CONTENT_LENGTH = 20000;

const str = (value, max) => (typeof value === 'string' ? value.slice(0, max) : undefined);

const validDate = (value) => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

const sanitizeAgreementProof = (proof) => {
  if (!proof || typeof proof !== 'object') return null;

  const termsSnapshot = Array.isArray(proof.termsSnapshot)
    ? proof.termsSnapshot
        .slice(0, MAX_SECTIONS)
        .map((s) => ({
          key: str(s?.key, 50),
          title: str(s?.title, 200),
          content: str(s?.content, MAX_CONTENT_LENGTH)
        }))
        .filter((s) => s.key && s.title && s.content)
    : [];

  const acknowledgements = {};
  ACK_KEYS.forEach((key) => {
    const ack = proof.acknowledgements?.[key];
    if (ack && typeof ack === 'object') {
      acknowledgements[key] = {
        accepted: ack.accepted === true,
        acceptedAt: validDate(ack.acceptedAt)
      };
    }
  });

  return {
    termsVersion: str(proof.termsVersion, 50),
    termsSnapshot,
    acknowledgements
  };
};

module.exports = { sanitizeAgreementProof };
