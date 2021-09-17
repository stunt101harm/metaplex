import * as anchor from '@project-serum/anchor';

import { TOKEN_PROGRAM_ID, Token } from '@solana/spl-token';
import { LAMPORTS_PER_SOL, TransactionInstruction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountInstruction,
  getAtaForMint,
} from './utils';

export const FAIR_LAUNCH_PROGRAM = new anchor.web3.PublicKey(
  '7HmfyvWK7LDohUL9TDAuGv9VFZHUce1SgYMkwti1xWwF',
);

export interface FairLaunchAccount {
  id: anchor.web3.PublicKey;
  program: anchor.Program;
  state: FairLaunchState;

  ticket: {
    pubkey: anchor.web3.PublicKey;
    bump: number;
    data?: FairLaunchTicket;
  };
  lotteryBitmap: {
    pubkey: anchor.web3.PublicKey;
  };
}

export interface FairLaunchTicket {
  fairLaunch: anchor.web3.PublicKey;
  buyer: anchor.web3.PublicKey;
  amount: anchor.BN;
  state: {
    punched?: {};
    unpunched?: {};
    withdrawn?: {};
    no_sequence_struct: {};
  };
  bump: number;
  seq: anchor.BN;
}

export interface AntiRugSetting {
  reserveBp: number;
  tokenRequirement: anchor.BN;
  selfDestructDate: anchor.BN;
}
export interface FairLaunchState {
  authority: anchor.web3.PublicKey;
  bump: number;

  currentMedian: anchor.BN;
  currentEligibleHolders: anchor.BN;
  data: {
    antiRugSetting?: AntiRugSetting;
    fee: anchor.BN;
    numberOfTokens: anchor.BN;
    phaseOneEnd: anchor.BN;
    phaseOneStart: anchor.BN;
    phaseTwoEnd: anchor.BN;
    priceRangeEnd: anchor.BN;
    priceRangeStart: anchor.BN;
    lotteryDuration: anchor.BN;
    tickSize: anchor.BN;
    uuid: string;
  };
  numberTicketsDropped: anchor.BN;
  numberTicketsPunched: anchor.BN;
  numberTicketsSold: anchor.BN;
  numberTicketsUnSeqed: anchor.BN;
  numberTokensBurnedForRefunds: anchor.BN;
  numberTokensPreminted: anchor.BN;
  phaseThreeStarted: boolean;
  tokenMint: anchor.web3.PublicKey;
  tokenMintBump: number;
  treasury: anchor.web3.PublicKey;
  treasuryBump: number;
  treasuryMint: null; // only for SPL tokens
  treasurySnapshot: null;
}

export const getFairLaunchState = async (
  anchorWallet: anchor.Wallet,
  fairLaunchId: anchor.web3.PublicKey,
  connection: anchor.web3.Connection,
): Promise<FairLaunchAccount> => {
  const provider = new anchor.Provider(connection, anchorWallet, {
    preflightCommitment: 'recent',
  });

  const idl = await anchor.Program.fetchIdl(FAIR_LAUNCH_PROGRAM, provider);

  const program = new anchor.Program(idl, FAIR_LAUNCH_PROGRAM, provider);
  const state: any = await program.account.fairLaunch.fetch(fairLaunchId);

  const [fairLaunchTicket, bump] = await getFairLaunchTicket(
    //@ts-ignore
    state.tokenMint,
    anchorWallet.publicKey,
  );

  let fairLaunchData: any;

  try {
    fairLaunchData = await program.account.fairLaunchTicket.fetch(
      fairLaunchTicket,
    );
  } catch {
    console.log('No ticket');
  }

  const fairLaunchLotteryBitmap = //@ts-ignore
  (await getFairLaunchLotteryBitmap(state.tokenMint))[0];

  return {
    id: fairLaunchId,
    state,
    program,
    ticket: {
      pubkey: fairLaunchTicket,
      bump,
      data: fairLaunchData,
    },
    lotteryBitmap: {
      pubkey: fairLaunchLotteryBitmap,
    },
  };
};

export const punchTicket = async (
  anchorWallet: anchor.Wallet,
  fairLaunch: FairLaunchAccount,
  ticket: FairLaunchTicket,
) => {
  const fairLaunchTicket = (
    await getFairLaunchTicket(
      //@ts-ignore
      fairLaunch.state.tokenMint,
      anchorWallet.publicKey,
    )
  )[0];

  const fairLaunchLotteryBitmap = //@ts-ignore
  (await getFairLaunchLotteryBitmap(fairLaunch.state.tokenMint))[0];

  const buyerTokenAccount = (
    await getAtaForMint(
      //@ts-ignore
      fairLaunch.state.tokenMint,
      anchorWallet.publicKey,
    )
  )[0];

  if (ticket.amount.toNumber() > fairLaunch.state.currentMedian.toNumber()) {
    console.log('Adjusting down...');
    const { remainingAccounts, instructions, signers } =
      await getSetupForTicketing(
        fairLaunch.state.currentMedian.toNumber(),
        anchorWallet,
        fairLaunch,
        ticket,
      );
    await fairLaunch.program.rpc.adjustTicket(fairLaunch.state.currentMedian, {
      accounts: {
        fairLaunchTicket,
        fairLaunch: fairLaunch.id,
        fairLaunchLotteryBitmap,
        //@ts-ignore
        treasury: fairLaunch.state.treasury,
        systemProgram: anchor.web3.SystemProgram.programId,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      },
      __private: { logAccounts: true },
      instructions: instructions.length > 0 ? instructions : undefined,
      remainingAccounts: [
        {
          pubkey: anchorWallet.publicKey,
          isSigner: true,
          isWritable: true,
        },
        ...remainingAccounts,
      ],
      signers,
    });
  }

  await fairLaunch.program.rpc.punchTicket({
    accounts: {
      fairLaunchTicket,
      fairLaunch: fairLaunch.id,
      fairLaunchLotteryBitmap,
      payer: anchorWallet.publicKey,
      buyerTokenAccount,
      //@ts-ignore
      tokenMint: fairLaunch.state.tokenMint,
      tokenProgram: TOKEN_PROGRAM_ID,
    },
    instructions: [
      createAssociatedTokenAccountInstruction(
        buyerTokenAccount,
        anchorWallet.publicKey,
        anchorWallet.publicKey,
        //@ts-ignore
        fairLaunch.state.tokenMint,
      ),
    ],
  });
};

export const getFairLaunchTicket = async (
  tokenMint: anchor.web3.PublicKey,
  buyer: anchor.web3.PublicKey,
): Promise<[anchor.web3.PublicKey, number]> => {
  return await anchor.web3.PublicKey.findProgramAddress(
    [Buffer.from('fair_launch'), tokenMint.toBuffer(), buyer.toBuffer()],
    FAIR_LAUNCH_PROGRAM,
  );
};

export const getFairLaunchLotteryBitmap = async (
  tokenMint: anchor.web3.PublicKey,
): Promise<[anchor.web3.PublicKey, number]> => {
  return await anchor.web3.PublicKey.findProgramAddress(
    [Buffer.from('fair_launch'), tokenMint.toBuffer(), Buffer.from('lottery')],
    FAIR_LAUNCH_PROGRAM,
  );
};

const getSetupForTicketing = async (
  amount: number,
  anchorWallet: anchor.Wallet,
  fairLaunch: FairLaunchAccount | undefined,
  ticket: FairLaunchTicket | null,
): Promise<{
  remainingAccounts: {
    pubkey: anchor.web3.PublicKey | null;
    isWritable: boolean;
    isSigner: boolean;
  }[];
  instructions: TransactionInstruction[];
  signers: anchor.web3.Keypair[];
  amountLamports: number;
}> => {
  if (!fairLaunch) {
    return {
      remainingAccounts: [],
      instructions: [],
      signers: [],
      amountLamports: 0,
    };
  }

  const remainingAccounts = [];
  const instructions = [];
  const signers = [];

  let amountLamports = 0;
  //@ts-ignore
  if (!fairLaunch.state.treasuryMint) {
    if (!ticket && amount === 0) {
      amountLamports = fairLaunch.state.data.priceRangeStart.toNumber();
    } else {
      amountLamports = Math.ceil(amount * LAMPORTS_PER_SOL);
    }
  } else {
    const transferAuthority = anchor.web3.Keypair.generate();
    signers.push(transferAuthority);
    // NOTE this token impl will not work till you get decimal mantissa and multiply...
    /// ex from cli wont work since you dont have a Signer, but an anchor.Wallet
    /*
    const token = new Token(
        anchorProgram.provider.connection,
        //@ts-ignore
        fairLaunchObj.treasuryMint,
        TOKEN_PROGRAM_ID,
        walletKeyPair,
      );
      const mintInfo = await token.getMintInfo();
      amountNumber = Math.ceil(amountNumber * 10 ** mintInfo.decimals);
    */
    instructions.push(
      Token.createApproveInstruction(
        TOKEN_PROGRAM_ID,
        //@ts-ignore
        fairLaunch.state.treasuryMint,
        transferAuthority.publicKey,
        anchorWallet.publicKey,
        [],
        //@ts-ignore

        // TODO: get mint decimals
        amountNumber + fairLaunch.state.data.fees.toNumber(),
      ),
    );

    remainingAccounts.push({
      //@ts-ignore
      pubkey: fairLaunch.state.treasuryMint,
      isWritable: true,
      isSigner: false,
    });
    remainingAccounts.push({
      pubkey: (
        await getAtaForMint(
          //@ts-ignore
          fairLaunch.state.treasuryMint,
          anchorWallet.publicKey,
        )
      )[0],
      isWritable: true,
      isSigner: false,
    });
    remainingAccounts.push({
      pubkey: transferAuthority.publicKey,
      isWritable: false,
      isSigner: true,
    });
    remainingAccounts.push({
      pubkey: TOKEN_PROGRAM_ID,
      isWritable: false,
      isSigner: false,
    });
  }

  return {
    remainingAccounts,
    instructions,
    signers,
    amountLamports,
  };
};
export const purchaseTicket = async (
  amount: number,
  anchorWallet: anchor.Wallet,
  fairLaunch: FairLaunchAccount | undefined,
  ticket: FairLaunchTicket | null,
) => {
  if (!fairLaunch) {
    return;
  }

  const { remainingAccounts, instructions, signers, amountLamports } =
    await getSetupForTicketing(amount, anchorWallet, fairLaunch, ticket);
  const [fairLaunchTicket, bump] = await getFairLaunchTicket(
    //@ts-ignore
    fairLaunch.state.tokenMint,
    anchorWallet.publicKey,
  );

  if (ticket) {
    const fairLaunchLotteryBitmap = ( //@ts-ignore
      await getFairLaunchLotteryBitmap(fairLaunch.state.tokenMint)
    )[0];
    console.log(
      'Anchor wallet',
      anchorWallet.publicKey.toBase58(),
      amountLamports,
    );
    await fairLaunch.program.rpc.adjustTicket(new anchor.BN(amountLamports), {
      accounts: {
        fairLaunchTicket,
        fairLaunch: fairLaunch.id,
        fairLaunchLotteryBitmap,
        //@ts-ignore
        treasury: fairLaunch.state.treasury,
        systemProgram: anchor.web3.SystemProgram.programId,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      },
      __private: { logAccounts: true },
      remainingAccounts: [
        {
          pubkey: anchorWallet.publicKey,
          isSigner: true,
          isWritable: true,
        },
        ...remainingAccounts,
      ],
      signers,
      instructions: instructions.length > 0 ? instructions : undefined,
    });

    return;
  }
  try {
    console.log('Amount', amountLamports);
    await fairLaunch.program.rpc.purchaseTicket(
      bump,
      new anchor.BN(amountLamports),
      {
        accounts: {
          fairLaunchTicket,
          fairLaunch: fairLaunch.id,
          //@ts-ignore
          treasury: fairLaunch.state.treasury,
          buyer: anchorWallet.publicKey,
          payer: anchorWallet.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
        },
        //__private: { logAccounts: true },
        remainingAccounts,
        signers,
        instructions: instructions.length > 0 ? instructions : undefined,
      },
    );
  } catch (e) {
    console.log(e);
    throw e;
  }
};

export const withdrawFunds = async (
  amount: number,
  anchorWallet: anchor.Wallet,
  fairLaunch: FairLaunchAccount | undefined,
) => {
  if (!fairLaunch) {
    return;
  }

  // TODO: create sequence ticket

  const remainingAccounts = [];

  //@ts-ignore
  if (fairLaunch.state.treasuryMint) {
    remainingAccounts.push({
      //@ts-ignore
      pubkey: fairLaunch.state.treasuryMint,
      isWritable: true,
      isSigner: false,
    });
    remainingAccounts.push({
      pubkey: (
        await getAtaForMint(
          //@ts-ignore
          fairLaunch.state.treasuryMint,
          anchorWallet.publicKey,
        )
      )[0],
      isWritable: true,
      isSigner: false,
    });
    remainingAccounts.push({
      pubkey: TOKEN_PROGRAM_ID,
      isWritable: false,
      isSigner: false,
    });
  }

  await fairLaunch.program.rpc.withdrawFunds({
    accounts: {
      fairLaunch: fairLaunch.id,
      // @ts-ignore
      treasury: fairLaunch.state.treasury,
      authority: anchorWallet.publicKey,
      // @ts-ignore
      tokenMint: fairLaunch.state.tokenMint,
      systemProgram: anchor.web3.SystemProgram.programId,
    },
    remainingAccounts,
  });
};