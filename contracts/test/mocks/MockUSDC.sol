// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockUSDC — ERC-20 à 6 décimales avec EIP-3009, pour les tests
/// @dev Pas de hook, pas de frais de transfert, pas de rebasing.
///
///      Ce mock implémente `receiveWithAuthorization` (EIP-3009) avec le même
///      domaine EIP-712 et le même typehash que FiatTokenV2_2, parce que c'est
///      désormais l'unique chemin de financement d'un mandat. Deux propriétés
///      du vrai token sont reproduites parce que la sécurité en dépend :
///      `to == msg.sender` (protection anti-interception) et l'unicité du
///      `nonce` par autorisant (protection anti-rejeu).
///
///      Il ne reproduit PAS la blacklist Circle ni le refus de `address(0)` :
///      l'audit a établi que ces comportements ne produisent pas de perte
///      imputable au contrat, `reclaim` étant rejouable sans borne temporelle.
contract MockUSDC {
    string public constant name = "USD Coin";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error InsufficientBalance();
    error InsufficientAllowance();
    error CallerMustBePayee();
    error AuthorizationUsed();
    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error InvalidSignature();

    // ── EIP-3009 ──────────────────────────────────────────────────────────
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH =
        keccak256(
            "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
        );

    /// @dev `authorizer => nonce => consommé`. C'est le token qui garantit
    ///      l'unicité, ce qui fait du nonce une `fundingRef` digne de ce nom.
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    event AuthorizationUsedEvent(address indexed authorizer, bytes32 indexed nonce);

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes("2")),
                block.chainid,
                address(this)
            )
        );
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        // La propriété qui distingue `receive` de `transfer` : seul le
        // destinataire peut soumettre l'autorisation. Personne ne peut donc
        // l'intercepter pour consommer le nonce à la place du contrat.
        if (to != msg.sender) revert CallerMustBePayee();
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (authorizationState[from][nonce]) revert AuthorizationUsed();

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
                )
            )
        );
        if (ecrecover(digest, v, r, s) != from) revert InvalidSignature();

        authorizationState[from][nonce] = true;
        emit AuthorizationUsedEvent(from, nonce);
        _transfer(from, to, value);
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function burn(address from, uint256 amount) external {
        if (balanceOf[from] < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] -= amount;
            totalSupply -= amount;
        }
        emit Transfer(from, address(0), amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance();
            unchecked {
                allowance[from][msg.sender] = allowed - amount;
            }
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (balanceOf[from] < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] -= amount;
        }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
