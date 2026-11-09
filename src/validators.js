const { z } = require('zod');

const passwordPolicy = z.string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[a-z]/, 'Password needs a lowercase letter')
  .regex(/[A-Z]/, 'Password needs an uppercase letter')
  .regex(/[0-9]/, 'Password needs a digit')
  .regex(/[^A-Za-z0-9]/, 'Password needs a special character');

const email = z.string().trim().toLowerCase().max(254).email('Enter a valid email address');
const name = (label, max = 100) => z.string().trim().min(1, `${label} is required`).max(max);
const phone = z.string().trim().regex(/^\+?[0-9 ()-]{7,15}$/, 'Enter a valid phone number')
  .optional().or(z.literal('').transform(() => undefined));

const ROLES = ['citizen', 'field_worker', 'researcher', 'admin'];
const STATUSES = ['active', 'inactive', 'suspended'];

const registerSchema = z.object({
  full_name: name('Full name'),
  email,
  password: passwordPolicy,
  confirm_password: z.string(),
  phone,
  state: name('State'),
  district: name('District'),
  village: name('Village'),
  role: z.string().optional(),
}).refine(d => d.password === d.confirm_password, { path: ['confirm_password'], message: 'Passwords do not match' });

const loginSchema = z.object({ email, password: z.string().min(1).max(128) });

const profileSchema = z.object({
  full_name: name('Full name'),
  phone,
  state: name('State'),
  district: name('District'),
  village: name('Village'),
}).strict();

const changePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: passwordPolicy,
  confirm_new_password: z.string(),
}).refine(d => d.new_password === d.confirm_new_password, { path: ['confirm_new_password'], message: 'Passwords do not match' });

const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  new_password: passwordPolicy,
  confirm_new_password: z.string(),
}).refine(d => d.new_password === d.confirm_new_password, { path: ['confirm_new_password'], message: 'Passwords do not match' });

const adminCreateUserSchema = z.object({
  full_name: name('Full name'), email, password: passwordPolicy, phone,
  state: name('State'), district: name('District'), village: name('Village'),
  role: z.enum(ROLES),
});

const adminPatchUserSchema = z.object({
  role: z.enum(ROLES).optional(),
  status: z.enum(STATUSES).optional(),
}).strict();

function validate(schema, body) {
  const r = schema.safeParse(body ?? {});
  if (r.success) return { data: r.data };
  const fields = {};
  for (const i of r.error.issues) fields[i.path.join('.') || '_'] ??= i.message;
  return { errors: fields };
}

module.exports = { passwordPolicy, registerSchema, loginSchema, profileSchema, changePasswordSchema,
  resetPasswordSchema, adminCreateUserSchema, adminPatchUserSchema, validate, ROLES, STATUSES, z };
