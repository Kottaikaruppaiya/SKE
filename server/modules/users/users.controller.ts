/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/authorize.ts';
import type { UsersService } from './users.service.ts';
import { validateCreateUser, validateUpdateUser } from './users.validator.ts';

export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  list = async (_req: AuthenticatedRequest, res: Response) => {
    const users = await this.usersService.listUsers();
    res.json(users);
  };

  create = async (req: AuthenticatedRequest, res: Response) => {
    const data = validateCreateUser(req.body);
    const created = await this.usersService.createUser(
      {
        email: data.email,
        name: data.name,
        role: data.role,
        isActive: data.isActive,
        mustChangePassword: data.mustChangePassword,
      },
      data.password
    );
    res.status(201).json(created);
  };

  update = async (req: AuthenticatedRequest, res: Response) => {
    const updates = validateUpdateUser(req.body);
    const updated = await this.usersService.updateUser(req.params.id, updates);
    res.json(updated);
  };

  remove = async (req: AuthenticatedRequest, res: Response) => {
    const result = await this.usersService.deleteUser(req.params.id, req.user!.id);
    res.json(result);
  };
}
