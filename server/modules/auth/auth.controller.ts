/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Request, Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/authorize.ts';
import type { AuthService } from './auth.service.ts';
import { validateChangePassword, validateLogin } from './auth.validator.ts';

export class AuthController {
  constructor(private readonly authService: AuthService) {}

  login = async (req: Request, res: Response) => {
    const { email, password } = validateLogin(req.body);
    const clientIp = req.ip || req.socket.remoteAddress || '127.0.0.1';
    const result = await this.authService.login(email, password, clientIp);
    res.json(result);
  };

  changePassword = async (req: AuthenticatedRequest, res: Response) => {
    const { currentPassword, newPassword } = validateChangePassword(req.body);
    const result = await this.authService.changePassword(req.user!, currentPassword, newPassword);
    res.json(result);
  };

  getDownloadTicket = async (req: AuthenticatedRequest, res: Response) => {
    const fileId = req.query.fileId ? String(req.query.fileId) : undefined;
    const ticket = this.authService.signDownloadTicket(req.user!, fileId);
    res.json({ ticket });
  };

  logout = async (req: AuthenticatedRequest, res: Response) => {
    const result = await this.authService.logout(req.token, req.user?.id);
    res.json(result);
  };

  me = async (req: AuthenticatedRequest, res: Response) => {
    res.json({ user: req.user });
  };
}
