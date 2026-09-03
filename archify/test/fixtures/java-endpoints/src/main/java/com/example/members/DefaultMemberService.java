package com.example.members;

import org.springframework.stereotype.Service;

@Service
public class DefaultMemberService implements MemberService {
    private final MemberRepository repository;
    private final MemberMapper mapper;

    public DefaultMemberService(MemberRepository repository, MemberMapper mapper) {
        this.repository = repository;
        this.mapper = mapper;
    }

    public MemberResponse create(CreateMemberRequest request) {
        Member member = mapper.toEntity(request);
        return mapper.toResponse(repository.save(member));
    }

    public MemberResponse findById(Long id) {
        return mapper.toResponse(repository.findById(id));
    }

    public MemberResponse update(Long id, UpdateMemberRequest request) {
        Member member = repository.findById(id);
        mapper.update(member, request);
        return mapper.toResponse(repository.save(member));
    }

    public void delete(Long id) {
        repository.deleteById(id);
    }
}
