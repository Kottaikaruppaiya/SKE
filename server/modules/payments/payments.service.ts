/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Payment, PaymentAllocation } from '../../../shared/contracts/index.ts';
import { NotFoundError } from '../../domain/errors/AppError.ts';
import type { AllocatePaymentInput, CreatePaymentInput, IPaymentsRepository } from './payments.repository.ts';

export class PaymentsService {
  constructor(private readonly paymentsRepo: IPaymentsRepository) {}

  async listPayments(): Promise<Payment[]> {
    return this.paymentsRepo.findAll();
  }

  async getPaymentById(id: string): Promise<Payment> {
    const payment = await this.paymentsRepo.findById(id);
    if (!payment) throw new NotFoundError('Payment not found.');
    return payment;
  }

  async createPayment(data: CreatePaymentInput): Promise<Payment> {
    return this.paymentsRepo.create(data);
  }

  async updatePayment(id: string, updates: Partial<Payment>): Promise<Payment> {
    return this.paymentsRepo.update(id, updates);
  }

  async deletePayment(id: string): Promise<{ success: boolean }> {
    return this.paymentsRepo.delete(id);
  }

  async allocatePayment(input: AllocatePaymentInput, actorUserId: string): Promise<PaymentAllocation> {
    return this.paymentsRepo.allocate(input, actorUserId);
  }

  async deallocatePayment(allocationId: string): Promise<{ success: boolean }> {
    return this.paymentsRepo.deallocate(allocationId);
  }
}
