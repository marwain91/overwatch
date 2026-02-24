import { RequestHandler } from 'express';
import { isValidSlug } from '../utils/validators';

/** Validate tenantId param format */
export const validateTenantId: RequestHandler = (req, res, next) => {
  const { tenantId } = req.params;
  if (tenantId && !isValidSlug(tenantId)) {
    return res.status(400).json({ error: 'Invalid tenant ID format' });
  }
  next();
};

/** Validate appId param format */
export const validateAppId: RequestHandler = (req, res, next) => {
  const { appId } = req.params;
  if (appId && !isValidSlug(appId)) {
    return res.status(400).json({ error: 'Invalid app ID format' });
  }
  next();
};
