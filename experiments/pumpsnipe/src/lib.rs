//! pumpsnipe — a pump.fun launch sniper, in Pinocchio.
//!
//! The one thing this does that a plain client-side buy cannot: it re-reads the
//! bonding curve **at execution time** and refuses the trade if the curve has
//! already moved past a bound you set. A sniper that loses the race would
//! otherwise still land and buy the top. This one reverts, and you pay the
//! transaction fee instead of the price.
//!
//! It deliberately knows almost nothing about pump.fun. The accounts and the
//! instruction data are forwarded verbatim, so it works against `buy`,
//! `buy_v2`, `buy_exact_quote_in_v2` or whatever ships next without a rebuild —
//! pump.fun changed its own account list twice while this was being written,
//! and its published IDL documents neither change. The only thing this program
//! insists on is the gate.
//!
//! ```text
//! instruction data
//!   [0]      curve_index                u8   where the bonding curve sits in
//!                                            the account list
//!   [1..9]   max_virtual_quote_reserves u64  the gate, little-endian
//!   [9..]    pump.fun's own instruction data, forwarded untouched
//! ```

#![no_std]

use pinocchio::{
    account::AccountView,
    address::Address,
    error::{ProgramError, ProgramResult},
    instruction::{InstructionAccount, InstructionView},
};

// Nothing in here allocates, so the program carries neither an allocator nor
// std's panic machinery. That is most of why the binary is a few KB.
pinocchio::program_entrypoint!(process_instruction, MAX_ACCOUNTS);
pinocchio::no_allocator!();
pinocchio::nostd_panic_handler!();

/// pump.fun's bonding-curve program, `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`.
/// The only program this will ever call.
const PUMP_FUN: Address = Address::new_from_array([
    1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104, 191, 23, 91, 170, 81, 137, 203, 151, 245,
    210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176,
]);

/// Anchor account discriminator for pump.fun's `BondingCurve`.
const CURVE_DISC: [u8; 8] = [0x17, 0xb7, 0xf8, 0x37, 0x60, 0xd8, 0xac, 0x60];

/// `BondingCurve`, after its 8-byte discriminator:
///   8..16  virtual_token_reserves : u64
///  16..24  virtual_quote_reserves : u64
///  24..32  real_token_reserves    : u64
///  32..40  real_quote_reserves    : u64
///  40..48  token_total_supply     : u64
///  48      complete               : bool
const OFF_V_TOKEN: usize = 8;
const OFF_V_QUOTE: usize = 16;
const OFF_COMPLETE: usize = 48;
const CURVE_MIN_LEN: usize = OFF_COMPLETE + 1;

/// Our own header: one byte of curve index, eight of gate.
const HEADER_LEN: usize = 9;

/// pump.fun's documented `buy` is 16 accounts; its live variants have used 18
/// and 27. Upper bound only — the real count comes from the caller.
const MIN_ACCOUNTS: usize = 16;
const MAX_ACCOUNTS: usize = 32;

/// Errors, surfaced as `ProgramError::Custom(n)`.
mod err {
    pub const BAD_IX_DATA: u32 = 1;
    pub const BAD_ACCOUNT_COUNT: u32 = 2;
    pub const CURVE_NOT_OWNED_BY_PUMP: u32 = 3;
    pub const CURVE_TOO_SMALL: u32 = 4;
    pub const NOT_A_BONDING_CURVE: u32 = 5;
    pub const CURVE_COMPLETE: u32 = 6;
    pub const LOST_THE_RACE: u32 = 7;
    pub const CURVE_DRAINED: u32 = 8;
    pub const NO_PUMP_ACCOUNT: u32 = 9;
    pub const CURVE_INDEX_OUT_OF_RANGE: u32 = 10;
}

#[inline(always)]
fn u64_at(buf: &[u8], off: usize) -> u64 {
    u64::from_le_bytes([
        buf[off],
        buf[off + 1],
        buf[off + 2],
        buf[off + 3],
        buf[off + 4],
        buf[off + 5],
        buf[off + 6],
        buf[off + 7],
    ])
}

pub fn process_instruction(
    _program_id: &Address,
    accounts: &mut [AccountView],
    data: &[u8],
) -> ProgramResult {
    if data.len() <= HEADER_LEN {
        return Err(ProgramError::Custom(err::BAD_IX_DATA));
    }
    let n = accounts.len();
    if n < MIN_ACCOUNTS || n > MAX_ACCOUNTS {
        return Err(ProgramError::Custom(err::BAD_ACCOUNT_COUNT));
    }

    let curve_index = data[0] as usize;
    let max_virtual_quote_reserves = u64_at(data, 1);
    let pump_data = &data[HEADER_LEN..];

    if curve_index >= n {
        return Err(ProgramError::Custom(err::CURVE_INDEX_OUT_OF_RANGE));
    }
    // We forward blindly, so the one thing we must be certain of is that the
    // program on the other end is really pump.fun.
    let mut has_pump = false;
    for a in accounts.iter() {
        if a.address() == &PUMP_FUN {
            has_pump = true;
            break;
        }
    }
    if !has_pump {
        return Err(ProgramError::Custom(err::NO_PUMP_ACCOUNT));
    }

    // --- the gate ----------------------------------------------------------
    {
        let curve = &accounts[curve_index];

        // Without this, anyone could pass a look-alike account holding
        // flattering numbers and walk us straight past our own check.
        if !curve.owned_by(&PUMP_FUN) {
            return Err(ProgramError::Custom(err::CURVE_NOT_OWNED_BY_PUMP));
        }
        if curve.data_len() < CURVE_MIN_LEN {
            return Err(ProgramError::Custom(err::CURVE_TOO_SMALL));
        }

        let bytes = curve.try_borrow()?;
        if bytes[..8] != CURVE_DISC {
            return Err(ProgramError::Custom(err::NOT_A_BONDING_CURVE));
        }
        // Already graduated to a real AMM — nothing left to snipe.
        if bytes[OFF_COMPLETE] != 0 {
            return Err(ProgramError::Custom(err::CURVE_COMPLETE));
        }
        // A curve with no tokens left would price us at infinity.
        if u64_at(&bytes, OFF_V_TOKEN) == 0 {
            return Err(ProgramError::Custom(err::CURVE_DRAINED));
        }
        // The whole point: somebody got here first and moved the price past
        // where we were willing to buy. Revert rather than pay it.
        if u64_at(&bytes, OFF_V_QUOTE) > max_virtual_quote_reserves {
            return Err(ProgramError::Custom(err::LOST_THE_RACE));
        }
    }

    // --- forward everything, untouched -------------------------------------
    // Each account keeps the writability and signer flags it arrived with, so
    // whatever shape pump.fun wants this week passes straight through.
    let mut metas: [core::mem::MaybeUninit<InstructionAccount>; MAX_ACCOUNTS] =
        unsafe { core::mem::MaybeUninit::uninit().assume_init() };
    let mut views: [core::mem::MaybeUninit<&AccountView>; MAX_ACCOUNTS] =
        unsafe { core::mem::MaybeUninit::uninit().assume_init() };
    for i in 0..n {
        metas[i].write(InstructionAccount::new(
            accounts[i].address(),
            accounts[i].is_writable(),
            accounts[i].is_signer(),
        ));
        views[i].write(&accounts[i]);
    }
    let metas =
        unsafe { core::slice::from_raw_parts(metas.as_ptr() as *const InstructionAccount, n) };
    let views = unsafe { core::slice::from_raw_parts(views.as_ptr() as *const &AccountView, n) };

    let ix = InstructionView {
        program_id: &PUMP_FUN,
        accounts: metas,
        data: pump_data,
    };

    pinocchio::cpi::invoke_with_bounds::<MAX_ACCOUNTS, _>(&ix, views)
}
